/**
 * problem_signature — golden vectors + cross-module-system agreement.
 *
 * Sprint 83 T2, interface I3. Three consumers must produce byte-identical
 * hashes across two module systems and two repos: mnestra's ESM write side,
 * T3's recall-side expansion, and TermDeck's CommonJS server. A divergence
 * does not raise — it just means a symptom written by one side never matches a
 * lookup from the other, and the "you solved this before" path silently
 * returns nothing forever. That failure is invisible in production, so it has
 * to be visible here.
 *
 * The pinned hashes are the contract. Regenerating them to make this suite go
 * green is exactly the wrong move: it converts a real cross-repo break into a
 * passing test. If the normalization genuinely must change, bump
 * PROBLEM_SIGNATURE_VERSION and regenerate deliberately, knowing every stored
 * signature is thereby invalidated.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  PROBLEM_CLASSES,
  PROBLEM_EXTRACTED_BY,
  PROBLEM_SIGNATURE_VERSION,
  classifyProblem,
  freeClass,
  normalizeSymptom,
  pickSymptomLine,
  problemLookupKey,
  problemSignature,
  redactSecrets,
  shouldSignProblem,
  symptomHash,
} from '../src/problem_signature.js';
import { redactQueryPreview } from '../src/recall_log.js';

interface Vector {
  name: string;
  raw: string;
  normalized: string;
  symptom_hash: string;
  class: string;
}

// Repo root from dist-tests/tests/<file>.js — the compiled location, which is
// where this actually runs. Read at runtime rather than `import`ed so the
// fixture needs no build-step handling and stays readable by the other repo.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '..', 'tests', 'fixtures', 'problem-signature-vectors.json');

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  signature_version: number;
  extracted_by: string;
  classes: string[];
  vectors: Vector[];
};

test('golden vectors: raw → normalized → symptom_hash → class', () => {
  assert.ok(fixture.vectors.length >= 10, 'fixture should cover a real spread of cases');
  for (const v of fixture.vectors) {
    const line = pickSymptomLine(v.raw);
    const normalized = normalizeSymptom(line);
    assert.equal(normalized, v.normalized, `normalized drift: ${v.name}`);
    assert.equal(symptomHash(normalized), v.symptom_hash, `hash drift: ${v.name}`);
    const cls = classifyProblem(line) ?? freeClass(normalized);
    assert.equal(cls, v.class, `class drift: ${v.name}`);
  }
});

test('fixture header pins the version and the class vocabulary', () => {
  assert.equal(fixture.signature_version, PROBLEM_SIGNATURE_VERSION);
  assert.equal(fixture.extracted_by, PROBLEM_EXTRACTED_BY);
  assert.deepEqual(fixture.classes, PROBLEM_CLASSES);
});

test('seed vocabulary matches the 5 doctrine err-* classes', () => {
  // Drift guard against TermDeck `doctrine/registry.jsonl`, which the core
  // vendors rather than reads (mnestra ships standalone; see the core header).
  // Vendoring's cost is silent drift — this makes it loud in review.
  assert.deepEqual(PROBLEM_CLASSES, [
    'err-git-push-rejected',
    'err-pg-permission-denied',
    'err-npm-publish-auth',
    'err-port-in-use',
    'err-gitleaks-blocked',
  ]);
});

test('the same failure normalizes identically across cosmetic differences', () => {
  // The whole point of the hash: colorized vs plain, and two machines running
  // the same failure at different paths/lines/pids, must collide. If they do
  // not, a recurrence never finds the fix that was already written down.
  const byClass = new Map<string, Set<string>>();
  for (const v of fixture.vectors) {
    if (!byClass.has(v.class)) byClass.set(v.class, new Set());
    byClass.get(v.class)!.add(v.symptom_hash);
  }
  assert.equal(
    byClass.get('err-pg-permission-denied')?.size,
    1,
    'ANSI-colorized and plain copies of one pg error must share a hash'
  );
  assert.equal(
    byClass.get('free:fatal-worker-failed-pid')?.size,
    1,
    'differing paths / line numbers / pids must collapse to one hash'
  );
});

test('secrets never survive into a stored symptom', () => {
  const leaky = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'AKIAIOSFODNN7EXAMPLE',
    'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'xoxb-1234567890-abcdefghijkl',
  ];
  for (const secret of leaky) {
    const out = normalizeSymptom(`connection failed using ${secret} while retrying`);
    assert.ok(!out.includes(secret.toLowerCase()), `leaked: ${secret.slice(0, 12)}…`);
    assert.ok(!out.includes(secret), `leaked verbatim: ${secret.slice(0, 12)}…`);
    assert.match(out, /\[redacted\]/);
  }
});

test('the core redactor agrees with recall_log on the shapes they share', () => {
  // The core deliberately DUPLICATES recall_log's secret shapes rather than
  // importing them, because importing would make it un-vendorable by TermDeck.
  // Duplication is only safe while the two stay equivalent — assert it.
  for (const v of fixture.vectors) {
    const viaCore = redactSecrets(v.raw).replace(/\s+/g, ' ').trim();
    const viaRecallLog = redactQueryPreview(v.raw, 100_000);
    assert.equal(viaCore, viaRecallLog, `redaction divergence on: ${v.name}`);
  }
});

test('shouldSignProblem triggers on bug_fix source_type OR debugging category', () => {
  // Sprint 82 finding: `debugging` and `convention` are Category values and are
  // NOT legal source_types. Keying on source_type alone would miss every
  // decision-typed write about a bug.
  assert.equal(shouldSignProblem({ source_type: 'bug_fix' }), true);
  assert.equal(shouldSignProblem({ category: 'debugging' }), true);
  assert.equal(shouldSignProblem({ source_type: 'decision', category: 'debugging' }), true);
  assert.equal(shouldSignProblem({ source_type: 'decision' }), false);
  assert.equal(shouldSignProblem({ source_type: 'fact', category: 'technical' }), false);
  assert.equal(shouldSignProblem({}), false);
});

test('problemSignature returns null for non-solved-problem writes', () => {
  assert.equal(
    problemSignature({ content: 'Josh prefers publish-before-push.', source_type: 'preference' }),
    null
  );
  // Solved-problem class but nothing usable to sign.
  assert.equal(problemSignature({ content: '   ', source_type: 'bug_fix' }), null);
});

test('problemSignature emits the full I3 shape', () => {
  const at = new Date('2026-07-31T18:00:00.000Z');
  const sig = problemSignature(
    { content: 'ERROR:  permission denied for table memory_items (code: 42501)', source_type: 'bug_fix' },
    at
  );
  assert.ok(sig);
  assert.equal(sig.v, PROBLEM_SIGNATURE_VERSION);
  assert.equal(sig.class, 'err-pg-permission-denied');
  assert.equal(sig.extracted_by, PROBLEM_EXTRACTED_BY);
  assert.equal(sig.extracted_at, at.toISOString());
  assert.equal(sig.symptom_hash, symptomHash(sig.symptom));
  assert.equal(Object.keys(sig).sort().join(','), 'class,extracted_at,extracted_by,symptom,symptom_hash,v');
});

test('explicit symptom_text wins over content-derived symptom', () => {
  const sig = problemSignature({
    content: 'Long write-up about how we finally fixed the deploy.',
    source_type: 'bug_fix',
    symptom_text: 'Error: listen EADDRINUSE: address already in use :::3000',
  });
  assert.equal(sig?.class, 'err-port-in-use');
});

test('problemLookupKey (read side) reproduces the write side exactly', () => {
  // T3 and TermDeck call this with a live error line; it must land on the same
  // {class, symptom_hash} the write side stored, or expansion matches nothing.
  for (const v of fixture.vectors) {
    const key = problemLookupKey(v.raw);
    assert.ok(key, `no lookup key for: ${v.name}`);
    assert.equal(key.symptom_hash, v.symptom_hash, `lookup hash drift: ${v.name}`);
    assert.equal(key.class, v.class, `lookup class drift: ${v.name}`);
  }
});

test('the core is consumable from CommonJS require() — TermDeck server path', () => {
  // TermDeck's server is CommonJS with no build step and no mnestra dependency;
  // it vendors this file. If `require()` ever breaks (an ESM-only syntax creeps
  // in, a bare import appears), the flashback path loses its normalizer and the
  // break shows up in the other repo, at runtime.
  const require_ = createRequire(import.meta.url);
  const core = require_('../src/problem_signature_core.cjs') as {
    normalizeSymptom: (s: string) => string;
    symptomHash: (s: string) => string;
    problemLookupKey: (s: string) => { class: string; symptom_hash: string } | null;
  };
  for (const v of fixture.vectors) {
    assert.equal(core.symptomHash(core.normalizeSymptom(pickSymptomLine(v.raw))), v.symptom_hash);
    assert.equal(core.problemLookupKey(v.raw)?.class, v.class);
  }
});

test('normalizeSymptom is total — never throws, never returns non-string', () => {
  for (const bad of [null, undefined, 42, {}, [], Symbol('x')]) {
    assert.equal(normalizeSymptom(bad as unknown), '');
  }
});

test('stored symptom respects the length cap', () => {
  const long = `error: ${'permission-denied '.repeat(80)}`;
  const out = normalizeSymptom(long);
  assert.ok(out.length <= 200, `symptom exceeded cap: ${out.length}`);
});

/**
 * Mnestra — recall-score calibration units (Sprint 82 T3).
 *
 * Pure units: no live DB, no network, no ambient env. Two distinct quantities
 * are under test and the tests are deliberately written to keep them apart —
 * a calibrated PROBABILITY (label-dependent, currently unavailable) and a band
 * PERCENTILE (label-free, available today).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFeatureVector,
  calibrateScore,
  scoreBandPercentile,
  withCalibratedScore,
  CALIBRATION_COEFFICIENTS,
  CALIBRATION_FEATURES,
  CALIBRATION_FITTED,
  CALIBRATION_VERSION,
  RRF_BAND_MAX,
  RRF_QUANTILE_KNOTS,
  SHIPPED_MODEL,
  type CalibrationModel,
} from '../src/calibration.js';
import type { RecallHit } from '../src/types.js';

// ── Version + shipped state ─────────────────────────────────────────────────

test('CALIBRATION_VERSION is an exported positive integer', () => {
  assert.equal(typeof CALIBRATION_VERSION, 'number');
  assert.ok(Number.isInteger(CALIBRATION_VERSION));
  assert.ok(CALIBRATION_VERSION >= 1);
});

test('shipped state is internally consistent: unfitted means no coefficients', () => {
  // The invariant that matters is the PAIRING, not the current value: a
  // FITTED=true with an empty coefficient vector (or vice versa) is the bug
  // this guards, and it would otherwise ship silently.
  if (CALIBRATION_FITTED) {
    assert.ok(CALIBRATION_COEFFICIENTS.length > 0);
    assert.equal(CALIBRATION_COEFFICIENTS.length, CALIBRATION_FEATURES.length);
    assert.equal(CALIBRATION_FEATURES[0], '(intercept)');
  } else {
    assert.equal(CALIBRATION_COEFFICIENTS.length, 0);
    assert.equal(CALIBRATION_FEATURES.length, 0);
  }
});

test('calibrateScore returns null while no model is fitted', () => {
  // Not an error path — the honest answer when nothing has been estimated.
  // See docs/calibration-report-2026-07-30.md: 2 positive labels in 39,150 rows.
  const p = calibrateScore({ score: 0.03, rank: 1, ageDays: 10, sourceType: 'decision' });
  assert.equal(p, CALIBRATION_FITTED ? p : null);
  if (!CALIBRATION_FITTED) assert.equal(p, null);
});

// ── Feature encoding contract ───────────────────────────────────────────────

const NAMES = [
  '(intercept)',
  'score',
  'log1p_rank',
  'log1p_age_days',
  'surface=search',
  'source_type=decision',
];

test('buildFeatureVector: encodes exactly the columns the fit script emits', () => {
  const x = buildFeatureVector(
    { score: 0.05, rank: 3, ageDays: 9, surface: 'search', sourceType: 'decision' },
    NAMES
  );
  assert.equal(x.length, NAMES.length);
  assert.equal(x[0], 1); // intercept
  assert.equal(x[1], 0.05); // raw score
  assert.ok(Math.abs((x[2] ?? 0) - Math.log1p(3)) < 1e-12);
  assert.ok(Math.abs((x[3] ?? 0) - Math.log1p(9)) < 1e-12);
  assert.equal(x[4], 1); // surface one-hot hit
  assert.equal(x[5], 1); // source_type one-hot hit
});

test('buildFeatureVector: an unseen categorical level contributes zeros', () => {
  // Reference-coded design: a level the fit never saw is not an error, it is
  // the reference category. Zeros are the correct encoding, not a throw.
  const x = buildFeatureVector(
    { score: 0.02, rank: 1, ageDays: 1, surface: 'timeline', sourceType: 'doctrine' },
    NAMES
  );
  assert.equal(x[4], 0);
  assert.equal(x[5], 0);
});

test('buildFeatureVector: missing/invalid inputs degrade to zeros, never NaN', () => {
  const x = buildFeatureVector({ score: Number.NaN }, NAMES);
  for (const v of x) assert.ok(Number.isFinite(v), `non-finite component: ${v}`);
  const y = buildFeatureVector({ score: 0.01, rank: null, ageDays: null }, NAMES);
  assert.equal(y[2], 0); // log1p(0)
  assert.equal(y[3], 0);
});

// ── Monotonicity of the calibrated probability ──────────────────────────────

/**
 * Monotonicity is a property of the logistic link plus a non-negative `score`
 * coefficient, and it must hold for ANY future fit with the expected sign —
 * so it is tested against the encoder + link directly rather than against the
 * currently-empty shipped coefficients (which would make the test vacuous and
 * silently stay vacuous after a fit lands).
 */
function probabilityUnder(beta: number[], score: number): number {
  const x = buildFeatureVector(
    { score, rank: 2, ageDays: 30, surface: 'search', sourceType: 'decision' },
    NAMES
  );
  let z = 0;
  for (let i = 0; i < x.length; i++) z += (x[i] ?? 0) * (beta[i] ?? 0);
  return 1 / (1 + Math.exp(-z));
}

test('calibrated probability is monotonic in raw score for fixed features', () => {
  const beta = [-4.0, 25.0, -0.3, -0.1, 0.2, 0.5]; // positive score coefficient
  let prev = -1;
  for (let s = 0; s <= RRF_BAND_MAX; s += RRF_BAND_MAX / 200) {
    const p = probabilityUnder(beta, s);
    assert.ok(p >= prev, `not monotonic at score=${s}: ${p} < ${prev}`);
    assert.ok(p >= 0 && p <= 1, `out of range at score=${s}: ${p}`);
    prev = p;
  }
});

// ── Band percentile (label-free) ────────────────────────────────────────────

test('scoreBandPercentile: monotonic, bounded, and saturating', () => {
  let prev = -1;
  for (let s = 0; s <= 0.09; s += 0.0002) {
    const v = scoreBandPercentile(s);
    assert.ok(v >= prev, `not monotonic at ${s}: ${v} < ${prev}`);
    assert.ok(v >= 0 && v <= 1);
    prev = v;
  }
  assert.equal(scoreBandPercentile(0), 0);
  assert.equal(scoreBandPercentile(0.9), 1); // above the band saturates
  assert.equal(scoreBandPercentile(Number.NaN), 0);
  assert.equal(scoreBandPercentile(Number.POSITIVE_INFINITY), 0);
});

test('scoreBandPercentile: every knot maps to its own quantile', () => {
  for (const [score, q] of RRF_QUANTILE_KNOTS) {
    assert.ok(
      Math.abs(scoreBandPercentile(score) - q) < 1e-9,
      `knot ${score} → expected ${q}, got ${scoreBandPercentile(score)}`
    );
  }
});

test('knots stay sorted ascending in both coordinates', () => {
  // Guards a bad telemetry refresh: unsorted knots silently break monotonicity.
  for (let i = 1; i < RRF_QUANTILE_KNOTS.length; i++) {
    assert.ok((RRF_QUANTILE_KNOTS[i]?.[0] ?? 0) > (RRF_QUANTILE_KNOTS[i - 1]?.[0] ?? 0));
    assert.ok((RRF_QUANTILE_KNOTS[i]?.[1] ?? 0) > (RRF_QUANTILE_KNOTS[i - 1]?.[1] ?? 0));
  }
});

test('RRF_BAND_MAX is the analytic ceiling, and the live median sits mid-band', () => {
  assert.ok(Math.abs(RRF_BAND_MAX - (2 / 61) * 1.5 * 1.5) < 1e-12);
  // Live p50 over the 90-day window is 0.0219; the brief quotes 0.0216.
  const mid = scoreBandPercentile(0.0216);
  assert.ok(mid > 0.45 && mid < 0.55, `expected mid-band, got ${mid}`);
});

test('band percentile and calibrated probability are NOT the same quantity', () => {
  // Regression guard on the documented contract: a percentile is available
  // without labels; a probability is not. If a future refactor ever makes
  // calibrateScore fall back to the percentile, this fails — which is the
  // point. Conflating them is the exact failure mode that got an RRF composite
  // rendered as a "similarity %".
  if (!CALIBRATION_FITTED) {
    assert.equal(calibrateScore({ score: 0.0216 }), null);
    assert.ok(scoreBandPercentile(0.0216) > 0.4);
  }
});

// ── Additive wire-in ────────────────────────────────────────────────────────

function hit(overrides: Partial<RecallHit> = {}): RecallHit {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    content: 'a memory',
    source_type: 'decision',
    category: null,
    project: 'termdeck',
    score: 0.0216,
    metadata: {},
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as RecallHit;
}

test('withCalibratedScore: field is ABSENT (not null, not 0) while unfitted', () => {
  const out = withCalibratedScore([hit()], 'recall');
  assert.equal(out.length, 1);
  assert.equal('score_calibrated' in (out[0] as object), CALIBRATION_FITTED);
  if (!CALIBRATION_FITTED) {
    // `'score_calibrated' in hit` must be a truthful test of "has anyone
    // estimated this" — a null or 0 placeholder would lie to that check.
    assert.equal(out[0]?.score_calibrated, undefined);
  }
});

test('withCalibratedScore: unfitted path returns the input by identity', () => {
  // Recall is latency-sensitive; the no-model path must not allocate.
  const input = [hit(), hit({ id: '22222222-2222-2222-2222-222222222222' })];
  const out = withCalibratedScore(input, 'recall');
  if (!CALIBRATION_FITTED) assert.equal(out, input);
});

test('withCalibratedScore: preserves order, arity and every existing field', () => {
  const input = [
    hit({ id: '11111111-1111-1111-1111-111111111111', score: 0.03 }),
    hit({ id: '22222222-2222-2222-2222-222222222222', score: 0.01 }),
  ];
  const out = withCalibratedScore(input, 'search');
  assert.equal(out.length, 2);
  assert.equal(out[0]?.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(out[1]?.id, '22222222-2222-2222-2222-222222222222');
  assert.equal(out[0]?.score, 0.03); // raw score untouched
  assert.equal(out[0]?.content, 'a memory');
});

test('withCalibratedScore: an unparseable created_at does not throw', () => {
  const out = withCalibratedScore([hit({ created_at: 'not-a-date' })], 'recall');
  assert.equal(out.length, 1);
});

// ── The FITTED branch ───────────────────────────────────────────────────────
//
// CALIBRATION_FITTED is false today, so every test above exercises only the
// absent-field path. These drive an injected model so the code that will run
// the day real coefficients land is not shipping unexecuted.

const FITTED: CalibrationModel = {
  fitted: true,
  features: NAMES,
  coefficients: [-4.0, 25.0, -0.3, -0.1, 0.2, 0.5],
};

test('FITTED: score_calibrated is present, in [0,1], and additive', () => {
  const out = withCalibratedScore([hit()], 'search', { model: FITTED, nowMs: Date.parse('2026-07-31T00:00:00Z') });
  const h = out[0];
  assert.ok(h);
  assert.ok('score_calibrated' in h);
  const p = h.score_calibrated;
  assert.equal(typeof p, 'number');
  assert.ok((p ?? -1) >= 0 && (p ?? 2) <= 1);
  // Everything that was there before is still there, unmodified.
  assert.equal(h.score, 0.0216);
  assert.equal(h.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(h.content, 'a memory');
});

test('FITTED: a stronger raw score yields a higher calibrated probability', () => {
  const now = Date.parse('2026-07-31T00:00:00Z');
  const weak = withCalibratedScore([hit({ score: 0.005 })], 'search', { model: FITTED, nowMs: now });
  const strong = withCalibratedScore([hit({ score: 0.07 })], 'search', { model: FITTED, nowMs: now });
  assert.ok((strong[0]?.score_calibrated ?? 0) > (weak[0]?.score_calibrated ?? 1));
});

test('FITTED: ranking is NOT changed — order in equals order out', () => {
  // Sprint 82 keeps the calibrated value display-only (PLANNING Non-goals).
  // A future refactor that sorts on it would fail here.
  const input = [
    hit({ id: '11111111-1111-1111-1111-111111111111', score: 0.005 }), // weaker first
    hit({ id: '22222222-2222-2222-2222-222222222222', score: 0.07 }),
  ];
  const out = withCalibratedScore(input, 'recall', { model: FITTED });
  assert.equal(out[0]?.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(out[1]?.id, '22222222-2222-2222-2222-222222222222');
});

test('FITTED: the injected model does not leak into the shipped one', () => {
  // Guards against a refactor that mutates SHIPPED_MODEL instead of reading it.
  assert.equal(SHIPPED_MODEL.fitted, CALIBRATION_FITTED);
  const out = withCalibratedScore([hit()], 'recall');
  assert.equal('score_calibrated' in (out[0] as object), CALIBRATION_FITTED);
});

test('a features/coefficients length mismatch yields null, not a bogus probability', () => {
  // The realistic way this breaks: someone pastes the coefficient array from
  // the fit report but edits the feature list. A misaligned dot product would
  // still return a confident-looking number.
  const misaligned: CalibrationModel = {
    fitted: true,
    features: NAMES,
    coefficients: [1, 2, 3], // too short
  };
  assert.equal(calibrateScore({ score: 0.03 }, misaligned), null);
  const out = withCalibratedScore([hit()], 'recall', { model: misaligned });
  assert.equal('score_calibrated' in (out[0] as object), false);
});

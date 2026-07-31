/**
 * calibration.ts — turning Mnestra's retrieval scores into numbers a consumer
 * may reason about cardinally.
 *
 * Sprint 82 T3. Two quantities live here, and the distinction between them is
 * the whole point of the file:
 *
 *   1. calibrateScore()      — P(this hit is actually useful | features).
 *                              A *probability*, estimated from outcome labels
 *                              by a Platt (logistic) fit. Requires labels.
 *                              Currently UNAVAILABLE — see CALIBRATION_FITTED.
 *
 *   2. scoreBandPercentile() — where a raw RRF score sits in the observed
 *                              distribution of RRF scores. A *percentile*,
 *                              estimated without any labels at all. Available
 *                              today.
 *
 * These are not interchangeable and must never be relabelled into each other.
 * A percentile says "this hit is stronger than 70% of logged hits"; it says
 * nothing whatsoever about whether hits at that strength are useful. Conflating
 * the two is precisely the failure mode that made the raw RRF composite get
 * rendered as a "similarity %" in the first place.
 *
 * Deterministic and self-contained: no DB access, no I/O, no clock. Everything
 * here is a pure function of its arguments plus the constants below.
 */

/**
 * Bump whenever the coefficients, the feature list, or the quantile knots
 * change. Written alongside any calibrated value so a consumer can tell
 * calibration generations apart.
 */
import type { RecallHit } from './types.js';

export const CALIBRATION_VERSION = 1;

// ── 1. Platt calibration (label-dependent) ──────────────────────────────────

/**
 * Whether a fitted model exists.
 *
 * **Currently `false`, deliberately.** `scripts/calibration/fit-platt.ts` was
 * written, run read-only against the daily-driver store, and refused to emit
 * coefficients: over 39,150 telemetry rows the outcome labels are 2 positives
 * (both test artefacts) and 0 `dismissed`. The full accounting, including why
 * the label channel is structurally starved rather than merely young, is in
 * `docs/calibration-report-2026-07-30.md`.
 *
 * Shipping coefficients fitted on two rows would be worse than shipping none,
 * because downstream nothing can tell a fabricated model from a real one by
 * looking at the numbers. So the flag is false, `calibrateScore()` returns
 * `null`, and callers omit the field entirely.
 *
 * To turn this on: re-run the fit script once labels exist (T2's flashback
 * funnel is the first real producer). It prints a paste-ready block. Set this
 * to `true`, paste the two arrays below, bump `CALIBRATION_VERSION`. Nothing
 * else in the codebase changes.
 */
export const CALIBRATION_FITTED = false;

/**
 * Feature column names, in coefficient order, starting with `(intercept)`.
 * Empty until a fit exists. Populated verbatim from the fit script's output so
 * that the design matrix used at inference is the one that was trained.
 */
export const CALIBRATION_FEATURES: readonly string[] = [];

/** Logistic coefficients aligned index-for-index with CALIBRATION_FEATURES. */
export const CALIBRATION_COEFFICIENTS: readonly number[] = [];

/**
 * A fitted (or unfitted) calibration model.
 *
 * Exists so the FITTED code path is reachable without a fit. Otherwise every
 * branch that matters — the one that runs the day real coefficients land —
 * would ship having never executed, and the tests would pass by being vacuous.
 * Production always uses SHIPPED_MODEL; only tests pass anything else.
 */
export interface CalibrationModel {
  fitted: boolean;
  features: readonly string[];
  coefficients: readonly number[];
}

/** The model compiled into this build. */
export const SHIPPED_MODEL: CalibrationModel = {
  fitted: CALIBRATION_FITTED,
  features: CALIBRATION_FEATURES,
  coefficients: CALIBRATION_COEFFICIENTS,
};

/** The inputs a calibrated probability is conditioned on. */
export interface CalibrationFeatures {
  /** Raw RRF composite from memory_hybrid_search. */
  score: number;
  /** 1-based position in the returned set. */
  rank?: number | null;
  /** Age of the memory at recall time, in days. */
  ageDays?: number | null;
  /** The memory's source_type. */
  sourceType?: string | null;
  /** Retrieval surface: recall | search | index | timeline | graph | webhook. */
  surface?: string | null;
}

/** Numerically stable logistic. */
function sigmoid(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Build the design row for a set of features, in `CALIBRATION_FEATURES` order.
 * Categorical columns are one-hot by exact name match (`surface=recall`,
 * `source_type=decision`), matching the encoding the fit script emits; an
 * unseen level contributes zeros, which is the correct behaviour for a
 * reference-coded design.
 *
 * Exported for testability — this is the piece with the encoding contract in
 * it, and the contract is worth pinning independently of whether a fit exists.
 */
export function buildFeatureVector(
  features: CalibrationFeatures,
  featureNames: readonly string[] = CALIBRATION_FEATURES
): number[] {
  const score = Number.isFinite(features.score) ? features.score : 0;
  const rank = Math.max(0, features.rank ?? 0);
  const ageDays = Math.max(0, features.ageDays ?? 0);
  const surface = features.surface ?? '';
  const sourceType = features.sourceType ?? '';

  return featureNames.map((name) => {
    if (name === '(intercept)') return 1;
    if (name === 'score') return score;
    if (name === 'log1p_rank') return Math.log1p(rank);
    if (name === 'log1p_age_days') return Math.log1p(ageDays);
    if (name.startsWith('surface=')) return surface === name.slice('surface='.length) ? 1 : 0;
    if (name.startsWith('source_type=')) {
      return sourceType === name.slice('source_type='.length) ? 1 : 0;
    }
    return 0;
  });
}

/**
 * P(useful | features) ∈ [0, 1], or `null` when no fitted model exists.
 *
 * `null` is not an error path — it is the honest answer when nothing has been
 * estimated. Callers surface the value as `score_calibrated` only when it is
 * non-null, so the field is absent rather than misleading on an uncalibrated
 * install.
 *
 * Monotonic non-decreasing in `score` for fixed other features whenever the
 * fitted `score` coefficient is non-negative (the expected sign: a better RRF
 * score should not lower the probability of usefulness). The fit script reports
 * the sign; a negative one is a red flag about the label set, not a licence to
 * ship it.
 */
export function calibrateScore(
  features: CalibrationFeatures,
  model: CalibrationModel = SHIPPED_MODEL
): number | null {
  if (!model.fitted) return null;
  if (model.coefficients.length === 0) return null;
  // A features/coefficients length mismatch means the pasted block and the
  // feature list drifted apart. Returning null (field absent) is the safe
  // failure: a silently misaligned dot product would produce a confident,
  // meaningless probability.
  if (model.coefficients.length !== model.features.length) return null;

  const x = buildFeatureVector(features, model.features);
  let z = 0;
  for (let i = 0; i < x.length; i++) z += (x[i] ?? 0) * (model.coefficients[i] ?? 0);
  const p = sigmoid(z);
  return Math.min(1, Math.max(0, p));
}

/**
 * Attach `score_calibrated` to a returned hit set, additively.
 *
 * When no fitted model exists this returns the input array **by identity** —
 * no copy, no allocation, no field. That is both the honest representation
 * ("nobody has estimated this") and the zero-cost path on what is today the
 * only path: recall is latency-sensitive and must not pay for a calibration
 * that does not exist.
 *
 * `rank` is the 1-based position in the set as returned, matching the
 * convention `logRecallHits` already uses, so the feature means the same thing
 * at inference as it did in the training data.
 *
 * The clock is confined to this one function (and injectable for tests) —
 * everything else in this module is a pure function of its arguments.
 */
export function withCalibratedScore<T extends RecallHit>(
  hits: T[],
  surface: string,
  opts: { nowMs?: number; model?: CalibrationModel } = {}
): T[] {
  const model = opts.model ?? SHIPPED_MODEL;
  if (!model.fitted) return hits;
  const nowMs = opts.nowMs ?? Date.now();
  return hits.map((hit, i) => {
    const created = Date.parse(hit.created_at);
    const ageDays = Number.isFinite(created)
      ? Math.max(0, (nowMs - created) / 86_400_000)
      : null;
    const p = calibrateScore(
      {
        score: hit.score,
        rank: i + 1,
        ageDays,
        sourceType: hit.source_type,
        surface,
      },
      model
    );
    return p === null ? hit : { ...hit, score_calibrated: p };
  });
}

// ── 2. Band percentile (label-free) ─────────────────────────────────────────

/**
 * Empirical quantile knots of the deployed RRF score distribution: `[score,
 * quantile]` pairs, ascending.
 *
 * PINNED SNAPSHOT — these are frozen measurements, not live values:
 *
 *   taken     2026-07-30 20:11 ET
 *   source    `public.memory_recall_log`, full 90-day retention window
 *   n         39,048  (after excluding the `graph` surface, which logs on a
 *                     different scale, and 71 migration smoke-test rows)
 *   query     the `percentile_cont` statement in "Refresh" below, verbatim
 *
 * The observed maximum, 0.07377007, is the analytic ceiling `2/(rrf_k+1) × 1.5
 * × 1.5 = 0.07377049` to seven significant figures — that knot cannot drift
 * upward, because it is pinned by arithmetic rather than by sampling.
 *
 * DRIFT IS REAL AND IS EXPECTED. This is a snapshot of a live, growing
 * distribution. An independent re-run one minute later (Sprint 82 T4, 20:12 ET)
 * measured n = 39,065 and p99 = 0.0502400456310754 against the 0.04917757
 * pinned here — a ~2% relative move in the p99 knot from 17 new rows.
 *
 * The honest characterisation: the BODY of the distribution (p10-p90) is
 * estimated from thousands of rows each and is stable; the TAIL knots (p95,
 * p99) sit where few rows do and are the least stable. The practical effect is
 * small — re-interpolating a score of 0.045 under T4's p99 instead of this one
 * moves the output by 0.002 — so pinning a snapshot is safe. What would NOT be
 * safe is treating these as live values, or refreshing them without bumping
 * `CALIBRATION_VERSION`, because then two recalls scored weeks apart would
 * silently use different maps.
 *
 * Canonical snapshot record: `docs/calibration-report-2026-07-30.md`
 * § Quantile snapshot.
 *
 * These knots are kept byte-identical with `rumen/src/confidence.ts`
 * `RRF_QUANTILE_KNOTS` — the two packages must agree about what a given RRF
 * score means, or a Rumen insight's confidence and a Mnestra recall's reported
 * strength will disagree about the same underlying hit.
 *
 * Refresh (and bump CALIBRATION_VERSION) with:
 *
 *   select q, percentile_cont(q) within group (order by score)
 *     from public.memory_recall_log,
 *          unnest(array[0,0.05,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.95,0.99,1.0]) as q
 *    where score is not null and score < 0.4 and surface <> 'graph'
 *    group by q order by q;
 */
export const RRF_QUANTILE_KNOTS: ReadonlyArray<readonly [number, number]> = [
  [0.00308726, 0.0],
  [0.00942629, 0.05],
  [0.0109489, 0.1],
  [0.01420284, 0.2],
  [0.01695351, 0.3],
  [0.01936442, 0.4],
  [0.02188507, 0.5],
  [0.024213, 0.6],
  [0.02671364, 0.7],
  [0.02951747, 0.8],
  [0.03268172, 0.9],
  [0.03486153, 0.95],
  [0.04917757, 0.99],
  [0.07377007, 1.0],
];

/** Analytic ceiling of the deployed RRF band: `2/(rrf_k+1) × 1.5 × 1.5`. */
export const RRF_BAND_MAX = (2 / 61) * 1.5 * 1.5;

/**
 * Where `score` sits in the observed RRF distribution, in [0, 1].
 *
 * Read as "stronger than this fraction of logged recall hits". This is NOT a
 * probability of usefulness and must not be presented as one, nor as a
 * similarity percentage — for a magnitude with physical meaning use
 * `semantic_similarity` (raw cosine, migration 033).
 *
 * Monotonic non-decreasing in `score` by construction. Non-finite input → 0.
 */
export function scoreBandPercentile(score: number): number {
  if (!Number.isFinite(score)) return 0;
  let loScore: number | undefined;
  let loQ = 0;
  for (const [hiScore, hiQ] of RRF_QUANTILE_KNOTS) {
    if (score <= hiScore) {
      if (loScore === undefined) return 0;
      const span = hiScore - loScore;
      if (span <= 0) return loQ;
      return loQ + ((score - loScore) / span) * (hiQ - loQ);
    }
    loScore = hiScore;
    loQ = hiQ;
  }
  return 1;
}

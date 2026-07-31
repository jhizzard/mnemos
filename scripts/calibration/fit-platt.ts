/**
 * fit-platt.ts — Platt (logistic) calibration of Mnestra recall scores.
 *
 * Sprint 82 T3. Fits P(useful | features) over the outcome labels in
 * public.memory_recall_log so that the ordinal RRF `score` can be reported as
 * something a consumer may reason about cardinally.
 *
 *   run:  node --experimental-strip-types scripts/calibration/fit-platt.ts
 *   env:  DATABASE_URL   (falls back to reading ~/.termdeck/secrets.env)
 *
 * STRICTLY READ-ONLY. Two independent guarantees, because "the script only has
 * SELECTs in it" is a promise about the code, not about the connection:
 *   1. every statement issued below is a SELECT;
 *   2. the session is pinned READ ONLY before the first query, so the server
 *      rejects any write this script could ever be edited to attempt.
 * Credentials are read from the environment and never printed; connection
 * errors are redacted before they reach stdout/stderr (a libpq error string
 * carries the DSN, which carries the project ref).
 *
 * HONESTY GATE. The script refuses to emit coefficients when the label set is
 * too small to identify them, and writes an INSUFFICIENT LABELS report
 * instead. Emitting a fitted-looking model from a handful of rows would be
 * worse than emitting nothing, because downstream nobody can tell the
 * difference by looking at the constants. See MIN_POSITIVES_ABSOLUTE and
 * MIN_EVENTS_PER_FEATURE below for the thresholds and their rationale.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
// Type-only imports are erased by Node's type stripping, and this module's own
// imports are all type-only, so importing it from a stripped script is safe.
import { RRF_QUANTILE_KNOTS } from '../../src/calibration.ts';

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Rows at or above this score are not RRF scores at all. Migrations 027 §9a and
 * 031 §5a ship post-apply verification snippets with hardcoded 'score', 0.9 /
 * 0.8 payloads; those rows were left in the live table. The analytic RRF
 * ceiling is 2/(60+1) x 1.5 x 1.5 = 0.0738, so anything >= 0.4 is definitionally
 * not a real hit.
 */
const SMOKE_SCORE_FLOOR = 0.4;

/**
 * The `graph` surface (memory_recall_graph) logs on a different scale entirely
 * — its rows are ~0.9 where recall/search/index rows are ~0.02. Pooling them
 * would put a handful of high-scoring rows in a distribution they do not belong
 * to. Excluded from the fit; reported separately.
 */
const EXCLUDED_SURFACES = ['graph'];

/**
 * Honesty gate. A logistic fit needs enough MINORITY-class events to identify
 * its coefficients; the standard epidemiological rule of thumb is 10-20 events
 * per predictor, and the low end of that is known to be optimistic. We require
 * 20 positives per surviving feature column AND an absolute floor of 100,
 * whichever is larger. Below that the script reports and stops.
 */
const MIN_EVENTS_PER_FEATURE = 20;
const MIN_POSITIVES_ABSOLUTE = 100;

/** Ridge penalty on the non-intercept coefficients — numerical conditioning. */
const RIDGE_LAMBDA = 1e-3;
const IRLS_MAX_ITER = 100;
const IRLS_TOLERANCE = 1e-8;

/** Deterministic 70/30 split. No RNG: the split is a pure function of row id. */
const TRAIN_FRACTION = 0.7;

const REPORT_PATH = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  'docs',
  'calibration-report-2026-07-30.md'
);

// ── Credentials ─────────────────────────────────────────────────────────────

/**
 * Resolve DATABASE_URL from the environment, falling back to ~/.termdeck/
 * secrets.env. The value is never logged, and never returned to a caller that
 * might log it — only handed straight to the pg client.
 */
function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const secretsPath = join(homedir(), '.termdeck', 'secrets.env');
  let raw: string;
  try {
    raw = readFileSync(secretsPath, 'utf8');
  } catch {
    throw new Error(
      `DATABASE_URL is not set and ${secretsPath} could not be read. ` +
        'Set DATABASE_URL in the environment and re-run.'
    );
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] === undefined) continue;
    const value = m[1].trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  }
  throw new Error(`DATABASE_URL not found in ${secretsPath}.`);
}

/**
 * libpq/pg error messages embed the DSN, which embeds the project ref. Scrub
 * anything URL-shaped before it can reach a log, a terminal, or a pasted
 * bug report.
 */
function redact(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/postgres(?:ql)?:\/\/\S*/gi, '<redacted-dsn>')
    .replace(/\b[a-z]{16,}\.(?:pooler\.)?supabase\.(?:com|co)\b/gi, '<redacted-host>');
}

// ── Data ────────────────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  score: number;
  rank: number | null;
  surface: string;
  source_type: string | null;
  age_days: number | null;
  cited: boolean;
  dismissed: boolean;
}

interface Dataset {
  rows: RawRow[];
  totalRows: number;
  nullScore: number;
  smokeRows: number;
  excludedSurfaceRows: number;
  citedAll: number;
  dismissedAll: number;
  firstRow: string | null;
  lastRow: string | null;
  perSurface: Array<{ surface: string; n: number; cited: number; dismissed: number }>;
}

async function load(client: pg.Client): Promise<Dataset> {
  // Census over the WHOLE table, before any filtering — the report has to be
  // able to say what was thrown away and why.
  const census = await client.query<{
    total: string;
    null_score: string;
    smoke: string;
    excluded_surface: string;
    cited: string;
    dismissed: string;
    first_row: Date | null;
    last_row: Date | null;
  }>(
    `select count(*)::text                                             as total,
            count(*) filter (where score is null)::text                as null_score,
            count(*) filter (where score >= $1)::text                  as smoke,
            count(*) filter (where surface = any($2::text[]))::text    as excluded_surface,
            count(*) filter (where cited)::text                        as cited,
            count(*) filter (where dismissed)::text                    as dismissed,
            min(created_at)                                            as first_row,
            max(created_at)                                            as last_row
       from public.memory_recall_log`,
    [SMOKE_SCORE_FLOOR, EXCLUDED_SURFACES]
  );

  const perSurface = await client.query<{
    surface: string;
    n: string;
    cited: string;
    dismissed: string;
  }>(
    `select surface,
            count(*)::text                          as n,
            count(*) filter (where cited)::text     as cited,
            count(*) filter (where dismissed)::text as dismissed
       from public.memory_recall_log
      group by surface
      order by count(*) desc`
  );

  // The modelling set. age_days is the memory's age AT RECALL TIME, which is
  // the causally correct feature — using "age now" would leak the passage of
  // time since the recall into a model meant to score recalls as they happen.
  const rows = await client.query<{
    id: string;
    score: string;
    rank: number | null;
    surface: string;
    source_type: string | null;
    age_days: string | null;
    cited: boolean;
    dismissed: boolean;
  }>(
    `select l.id::text                                                        as id,
            l.score::text                                                     as score,
            l.rank                                                            as rank,
            l.surface                                                         as surface,
            coalesce(l.source_type, m.source_type)                            as source_type,
            extract(epoch from (l.created_at - m.created_at))::float8 / 86400.0 as age_days,
            l.cited                                                           as cited,
            l.dismissed                                                       as dismissed
       from public.memory_recall_log l
       left join public.memory_items m on m.id = l.memory_id
      where l.score is not null
        and l.score < $1
        and not (l.surface = any($2::text[]))`,
    [SMOKE_SCORE_FLOOR, EXCLUDED_SURFACES]
  );

  const c = census.rows[0];
  return {
    rows: rows.rows.map((r) => ({
      id: r.id,
      score: Number(r.score),
      rank: r.rank,
      surface: r.surface,
      source_type: r.source_type,
      age_days: r.age_days === null ? null : Number(r.age_days),
      cited: r.cited,
      dismissed: r.dismissed,
    })),
    totalRows: Number(c?.total ?? 0),
    nullScore: Number(c?.null_score ?? 0),
    smokeRows: Number(c?.smoke ?? 0),
    excludedSurfaceRows: Number(c?.excluded_surface ?? 0),
    citedAll: Number(c?.cited ?? 0),
    dismissedAll: Number(c?.dismissed ?? 0),
    firstRow: c?.first_row ? c.first_row.toISOString() : null,
    lastRow: c?.last_row ? c.last_row.toISOString() : null,
    perSurface: perSurface.rows.map((r) => ({
      surface: r.surface,
      n: Number(r.n),
      cited: Number(r.cited),
      dismissed: Number(r.dismissed),
    })),
  };
}

// ── Quantile snapshot + drift ───────────────────────────────────────────────

/** The quantiles the pinned knot tables were measured at. */
const SNAPSHOT_QUANTILES = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.0];

/** Provenance of the knot tables pinned in src/calibration.ts + rumen's confidence.ts. */
const SNAPSHOT_TAKEN_ET = '2026-07-30 20:11 ET';
const SNAPSHOT_N = 39048;

/** The measurement, verbatim — reproducing the snapshot means running exactly this. */
const SNAPSHOT_QUERY = `select q, percentile_cont(q) within group (order by score) as score
  from public.memory_recall_log,
       unnest(array[${SNAPSHOT_QUANTILES.join(',')}]) as q
 where score is not null and score < ${SMOKE_SCORE_FLOOR} and surface <> 'graph'
 group by q order by q;`;

interface LiveQuantiles {
  n: number;
  byQuantile: Map<number, number>;
}

/** Re-measure the distribution NOW, so the report can quantify drift itself. */
async function loadLiveQuantiles(client: pg.Client): Promise<LiveQuantiles> {
  const res = await client.query<{ q: string; score: string | null }>(
    `select q::text as q,
            (percentile_cont(q) within group (order by score))::text as score
       from public.memory_recall_log,
            unnest($1::float8[]) as q
      where score is not null and score < $2 and surface <> all($3::text[])
      group by q order by q`,
    [SNAPSHOT_QUANTILES, SMOKE_SCORE_FLOOR, EXCLUDED_SURFACES]
  );
  const count = await client.query<{ n: string }>(
    `select count(*)::text as n
       from public.memory_recall_log
      where score is not null and score < $1 and surface <> all($2::text[])`,
    [SMOKE_SCORE_FLOOR, EXCLUDED_SURFACES]
  );
  const byQuantile = new Map<number, number>();
  for (const r of res.rows) {
    if (r.score !== null) byQuantile.set(Number(r.q), Number(r.score));
  }
  return { n: Number(count.rows[0]?.n ?? 0), byQuantile };
}

/**
 * The canonical, single-source record of where the pinned knots came from and
 * how far they have moved. Emitted into the report on EVERY run — which is
 * also why it is generated rather than hand-written: this file is overwritten
 * each time the script runs, so a hand-added section would be destroyed.
 *
 * Both consumers of the knot table (`src/calibration.ts` and rumen's
 * `src/confidence.ts`) point here.
 */
function quantileSnapshotSection(live: LiveQuantiles, generatedAt: string): string {
  const rows = RRF_QUANTILE_KNOTS.map(([pinnedScore, q]) => {
    const now = live.byQuantile.get(q);
    if (now === undefined) {
      return `| ${q} | ${pinnedScore} | _not measured_ | — |`;
    }
    const delta = now - pinnedScore;
    const rel = pinnedScore === 0 ? 0 : (delta / pinnedScore) * 100;
    const sign = delta >= 0 ? '+' : '';
    return `| ${q} | ${pinnedScore} | ${now.toPrecision(9)} | ${sign}${delta.toExponential(2)} (${sign}${rel.toFixed(2)}%) |`;
  }).join('\n');

  return `## Quantile snapshot

This is the canonical record for the empirical quantile knots pinned in **both**
\`src/calibration.ts\` (\`RRF_QUANTILE_KNOTS\`) and
\`rumen/src/confidence.ts\` (\`RRF_QUANTILE_KNOTS\`). The two tables are kept
byte-identical on purpose: if they diverge, a Rumen insight's confidence and a
Mnestra recall's reported strength disagree about the same underlying hit.

| | |
|---|---|
| snapshot taken | ${SNAPSHOT_TAKEN_ET} |
| source | \`public.memory_recall_log\`, full 90-day retention window |
| n at snapshot | ${SNAPSHOT_N.toLocaleString()} |
| exclusions | \`graph\` surface (different score scale) + ${'`score >= '}${SMOKE_SCORE_FLOOR}\` migration smoke rows |
| this report generated | ${generatedAt} |
| n now | ${live.n.toLocaleString()} |

Measurement query, verbatim — reproducing the snapshot means running exactly this:

\`\`\`sql
${SNAPSHOT_QUERY}
\`\`\`

### Pinned vs. live — drift

| quantile | pinned | live (this run) | drift |
|---|---|---|---|
${rows}

**Drift is real and expected — these are frozen measurements of a live, growing
distribution.** An independent re-run one minute after the snapshot (Sprint 82
T4, 2026-07-30 20:12 ET) measured n = 39,065 and p99 = 0.0502400456310754
against the pinned 0.04917757: a ~2% relative move in the p99 knot from 17 new
rows.

The honest characterisation is that the two halves of the table behave
differently. The **body** (p10–p90) is estimated from thousands of rows per knot
and is stable. The **tail** (p95, p99) sits where few rows do and is the least
stable estimate in the table. The p100 knot cannot drift upward at all — it is
the analytic ceiling \`2/(rrf_k+1) × 1.5 × 1.5\`, pinned by arithmetic rather
than by sampling.

The practical effect of the observed tail drift is small: re-interpolating a
score of 0.045 under T4's p99 rather than the pinned one moves the normalized
output by 0.002. So pinning a snapshot is safe. What is **not** safe is
treating these as live values, or refreshing them without bumping
\`CALIBRATION_VERSION\` / \`NORMALIZE_VERSION\` — two recalls scored weeks apart
would then silently use different maps, and nothing downstream could tell.

Refresh procedure: re-run the query above, replace both knot tables, bump both
version constants in the same change.

`;
}

// ── Feature engineering ─────────────────────────────────────────────────────

interface Design {
  /** Feature matrix INCLUDING a leading intercept column of 1s. */
  X: number[][];
  y: number[];
  ids: string[];
  featureNames: string[];
  /** Columns dropped for zero variance, with the reason. */
  dropped: Array<{ name: string; reason: string }>;
}

/**
 * Label: cited is the positive signal ("actually used"). dismissed and
 * surfaced-only are both negatives — a recall hit that was returned and never
 * acted on is exactly the negative class we want to push down.
 */
function labelOf(r: RawRow): number {
  return r.cited ? 1 : 0;
}

function buildDesign(rows: RawRow[]): Design {
  // Candidate columns. Categorical levels are taken from the data, dropping the
  // most common level as the reference category to avoid collinearity with the
  // intercept.
  const surfaces = [...new Set(rows.map((r) => r.surface))].sort();
  const surfaceCounts = new Map<string, number>();
  for (const r of rows) surfaceCounts.set(r.surface, (surfaceCounts.get(r.surface) ?? 0) + 1);
  const refSurface = surfaces.slice().sort(
    (a, b) => (surfaceCounts.get(b) ?? 0) - (surfaceCounts.get(a) ?? 0)
  )[0];

  const types = [...new Set(rows.map((r) => r.source_type ?? '<null>'))].sort();
  const typeCounts = new Map<string, number>();
  for (const r of rows) {
    const k = r.source_type ?? '<null>';
    typeCounts.set(k, (typeCounts.get(k) ?? 0) + 1);
  }
  const refType = types.slice().sort((a, b) => (typeCounts.get(b) ?? 0) - (typeCounts.get(a) ?? 0))[0];

  const names: string[] = ['(intercept)', 'score', 'log1p_rank', 'log1p_age_days'];
  for (const s of surfaces) if (s !== refSurface) names.push(`surface=${s}`);
  for (const t of types) if (t !== refType) names.push(`source_type=${t}`);

  const X: number[][] = [];
  const y: number[] = [];
  const ids: string[] = [];

  for (const r of rows) {
    const row: number[] = [
      1,
      r.score,
      Math.log1p(Math.max(0, r.rank ?? 0)),
      Math.log1p(Math.max(0, r.age_days ?? 0)),
    ];
    for (const s of surfaces) if (s !== refSurface) row.push(r.surface === s ? 1 : 0);
    for (const t of types) if (t !== refType) row.push((r.source_type ?? '<null>') === t ? 1 : 0);
    X.push(row);
    y.push(labelOf(r));
    ids.push(r.id);
  }

  // Drop zero-variance columns. This is what happens to source_type when the
  // provenance wiring is not populating it: the one-hot block collapses to a
  // single constant level and carries no information. Silently keeping it would
  // produce an unidentifiable coefficient with a huge standard error.
  const dropped: Array<{ name: string; reason: string }> = [];
  const keep: number[] = [0]; // always keep the intercept
  for (let j = 1; j < names.length; j++) {
    let min = Infinity;
    let max = -Infinity;
    for (const row of X) {
      const v = row[j] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max - min < 1e-12) {
      dropped.push({ name: names[j] ?? `col${j}`, reason: `constant at ${min}` });
    } else {
      keep.push(j);
    }
  }

  return {
    X: X.map((row) => keep.map((j) => row[j] ?? 0)),
    y,
    ids,
    featureNames: keep.map((j) => names[j] ?? `col${j}`),
    dropped,
  };
}

// ── Deterministic split ─────────────────────────────────────────────────────

/** FNV-1a over the row id — a stable, seedless, reproducible hash. */
function hashUnit(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

// ── Logistic regression (IRLS with ridge) ───────────────────────────────────

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Solve (A + λI)b = c by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]?.[col] ?? 0) > Math.abs(M[pivot]?.[col] ?? 0)) pivot = r;
    }
    const pivotRow = M[pivot];
    const colRow = M[col];
    if (!pivotRow || !colRow) return null;
    if (Math.abs(pivotRow[col] ?? 0) < 1e-12) return null; // singular
    M[pivot] = colRow;
    M[col] = pivotRow;
    const lead = M[col]?.[col] ?? 1;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = (M[r]?.[col] ?? 0) / lead;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        const cur = M[r]?.[c] ?? 0;
        M[r]![c] = cur - factor * (M[col]?.[c] ?? 0);
      }
    }
  }
  return Array.from({ length: n }, (_, i) => (M[i]?.[n] ?? 0) / (M[i]?.[i] ?? 1));
}

function fitLogistic(X: number[][], y: number[]): { beta: number[]; iterations: number } | null {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) return null;
  let beta = new Array<number>(p).fill(0);

  for (let iter = 1; iter <= IRLS_MAX_ITER; iter++) {
    // Gradient and Hessian of the penalized log-likelihood.
    const grad = new Array<number>(p).fill(0);
    const H: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));

    for (let i = 0; i < n; i++) {
      const xi = X[i];
      if (!xi) continue;
      let z = 0;
      for (let j = 0; j < p; j++) z += (xi[j] ?? 0) * (beta[j] ?? 0);
      const mu = sigmoid(z);
      const w = Math.max(mu * (1 - mu), 1e-10);
      const resid = (y[i] ?? 0) - mu;
      for (let j = 0; j < p; j++) {
        grad[j] = (grad[j] ?? 0) + (xi[j] ?? 0) * resid;
        for (let k = j; k < p; k++) {
          const add = w * (xi[j] ?? 0) * (xi[k] ?? 0);
          H[j]![k] = (H[j]?.[k] ?? 0) + add;
        }
      }
    }
    // Symmetrize + ridge (intercept unpenalized).
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < j; k++) H[j]![k] = H[k]?.[j] ?? 0;
      if (j > 0) {
        H[j]![j] = (H[j]?.[j] ?? 0) + RIDGE_LAMBDA;
        grad[j] = (grad[j] ?? 0) - RIDGE_LAMBDA * (beta[j] ?? 0);
      }
    }

    const step = solve(H, grad);
    if (!step) return null;
    let delta = 0;
    for (let j = 0; j < p; j++) {
      beta[j] = (beta[j] ?? 0) + (step[j] ?? 0);
      delta = Math.max(delta, Math.abs(step[j] ?? 0));
    }
    if (delta < IRLS_TOLERANCE) return { beta, iterations: iter };
  }
  return { beta, iterations: IRLS_MAX_ITER };
}

// ── Metrics ─────────────────────────────────────────────────────────────────

/** Rank-based AUC (Mann-Whitney U), tie-aware. */
function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((s, i) => ({ s, y: labels[i] ?? 0 })).sort((a, b) => a.s - b.s);
  const ranks = new Array<number>(idx.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]?.s === idx[i]?.s) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  let nPos = 0;
  for (let k = 0; k < idx.length; k++) {
    if ((idx[k]?.y ?? 0) === 1) {
      sumPos += ranks[k] ?? 0;
      nPos++;
    }
  }
  const nNeg = idx.length - nPos;
  if (nPos === 0 || nNeg === 0) return NaN;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function brier(p: number[], y: number[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += ((p[i] ?? 0) - (y[i] ?? 0)) ** 2;
  return s / Math.max(1, p.length);
}

function logLoss(p: number[], y: number[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = Math.min(1 - 1e-12, Math.max(1e-12, p[i] ?? 0));
    s += (y[i] ?? 0) === 1 ? -Math.log(pi) : -Math.log(1 - pi);
  }
  return s / Math.max(1, p.length);
}

// ── Report ──────────────────────────────────────────────────────────────────

function insufficientLabelsReport(
  d: Dataset,
  design: Design,
  required: number,
  snapshot: string
): string {
  const pos = design.y.reduce((a, b) => a + b, 0);
  const neg = design.y.length - pos;
  const surfaceTable = d.perSurface
    .map((s) => `| \`${s.surface}\` | ${s.n.toLocaleString()} | ${s.cited} | ${s.dismissed} |`)
    .join('\n');

  return `# Recall-score calibration report — 2026-07-30

**Verdict: INSUFFICIENT LABELS. No model was fitted and no coefficients were emitted.**

Generated by \`scripts/calibration/fit-platt.ts\` (Sprint 82 T3), read-only against
the daily-driver Mnestra store.

## Why there is no model

A Platt fit maps features to a probability by maximising the likelihood of
observed outcomes. That requires observed outcomes. The telemetry table has
essentially none:

| quantity | value |
|---|---|
| rows in \`memory_recall_log\` | ${d.totalRows.toLocaleString()} |
| rows usable for modelling (after filters below) | ${design.y.length.toLocaleString()} |
| **positives (\`cited\`)** | **${pos}** |
| negatives (surfaced-only + \`dismissed\`) | ${neg.toLocaleString()} |
| \`dismissed = true\` anywhere in the table | ${d.dismissedAll} |
| positives required to fit ${design.featureNames.length - 1} feature(s) | ${required} |

Observation window: ${d.firstRow ?? 'n/a'} → ${d.lastRow ?? 'n/a'}.

With ${pos} positive event(s), the coefficients are not identifiable. Any
AUC, Brier score or coefficient vector reported from this data would be an
artefact of a handful of rows, and — the real danger — would be
indistinguishable downstream from a genuine fit. The script therefore stops
here by design (\`MIN_POSITIVES_ABSOLUTE = ${MIN_POSITIVES_ABSOLUTE}\`,
\`MIN_EVENTS_PER_FEATURE = ${MIN_EVENTS_PER_FEATURE}\`).

## Where the labels are supposed to come from

\`cited\` is written by \`mark_recall_feedback()\` (migration 027 §5), called from
exactly two places in the TypeScript:

- \`src/layered.ts:266\` — \`markRecallCited\`, on the \`memory_get\` path.
- \`src/webhook-server.ts:92\` — the webhook \`op:'feedback'\` receiver.

The dominant retrieval path, \`memory_recall\`, returns memory **content inline**.
An agent that reads that content and acts on it has no reason to then call
\`memory_get\`, so it never emits a citation. The label channel is not young —
it is structurally starved. Sprint 82's flashback funnel (T2: clicked /
dismissed / expired) is the first real producer of these labels.

## Data hygiene applied before counting

| filter | rows removed | rationale |
|---|---|---|
| \`score IS NULL\` | ${d.nullScore} | no feature to fit on |
| \`score >= ${SMOKE_SCORE_FLOOR}\` | ${d.smokeRows} | migration smoke-test payloads (hardcoded 0.9 / 0.8 in \`027\` §9a and \`031\` §5a) — not RRF scores |
| \`surface IN (${EXCLUDED_SURFACES.map((s) => `'${s}'`).join(', ')})\` | ${d.excludedSurfaceRows} | logs on a different score scale (~0.9 vs ~0.02) |

Feature columns dropped for zero variance:

${
  design.dropped.length === 0
    ? '_none_'
    : design.dropped.map((x) => `- \`${x.name}\` — ${x.reason}`).join('\n')
}

## Per-surface census

| surface | rows | cited | dismissed |
|---|---|---|---|
${surfaceTable}

## What to do

1. Land the T2 flashback funnel so \`clicked\` / \`dismissed\` start accumulating.
2. Consider emitting \`cited\` from the \`memory_recall\` path itself — e.g. a
   lightweight follow-up signal when a recalled memory's content appears in the
   agent's subsequent output. Without that, \`memory_get\` remains the only
   producer and the class stays rare.
3. Re-run this script. It writes coefficients the moment the gate passes; no
   other code has to change.

Until then \`src/calibration.ts\` ships with \`CALIBRATION_FITTED = false\`, and
\`score_calibrated\` is deliberately **absent** from recall output rather than
present and wrong.

${snapshot}`;
}

function fittedReport(
  d: Dataset,
  design: Design,
  beta: number[],
  iterations: number,
  metrics: {
    trainN: number;
    testN: number;
    testPos: number;
    aucModel: number;
    aucBaseline: number;
    brierModel: number;
    brierBase: number;
    logLossModel: number;
  },
  snapshot: string
): string {
  const coefTable = design.featureNames
    .map((n, i) => `| \`${n}\` | ${(beta[i] ?? 0).toFixed(6)} |`)
    .join('\n');
  return `# Recall-score calibration report — 2026-07-30

**Verdict: FITTED.** Generated by \`scripts/calibration/fit-platt.ts\` (Sprint 82 T3),
read-only against the daily-driver Mnestra store.

## Data

| quantity | value |
|---|---|
| rows in \`memory_recall_log\` | ${d.totalRows.toLocaleString()} |
| usable rows after hygiene filters | ${design.y.length.toLocaleString()} |
| positives (\`cited\`) | ${design.y.reduce((a, b) => a + b, 0).toLocaleString()} |
| train / test | ${metrics.trainN.toLocaleString()} / ${metrics.testN.toLocaleString()} |
| test-set positives | ${metrics.testPos.toLocaleString()} |
| IRLS iterations to converge | ${iterations} |

Split is deterministic (FNV-1a over the log row id, ${Math.round(TRAIN_FRACTION * 100)}/${
    100 - Math.round(TRAIN_FRACTION * 100)
  }), so this report is reproducible.

## Coefficients

| feature | coefficient |
|---|---|
${coefTable}

## Held-out performance — and the number that matters

| metric | model | trivial baseline (raw \`score\`) |
|---|---|---|
| AUC | ${metrics.aucModel.toFixed(4)} | ${metrics.aucBaseline.toFixed(4)} |
| Brier | ${metrics.brierModel.toFixed(5)} | ${metrics.brierBase.toFixed(5)} |
| log-loss | ${metrics.logLossModel.toFixed(5)} | — |

**Lift over the trivial baseline is ${(metrics.aucModel - metrics.aucBaseline).toFixed(4)} AUC.**
A high absolute AUC on a heavily imbalanced problem is close to meaningless on
its own; the honest question is whether the fitted model beats simply ranking
by the raw score, which costs nothing. Read the lift, not the headline.

## Data hygiene applied

| filter | rows removed |
|---|---|
| \`score IS NULL\` | ${d.nullScore} |
| \`score >= ${SMOKE_SCORE_FLOOR}\` (migration smoke rows) | ${d.smokeRows} |
| excluded surfaces (${EXCLUDED_SURFACES.join(', ')}) | ${d.excludedSurfaceRows} |

Columns dropped for zero variance:

${
  design.dropped.length === 0
    ? '_none_'
    : design.dropped.map((x) => `- \`${x.name}\` — ${x.reason}`).join('\n')
}

## Paste into \`src/calibration.ts\`

\`\`\`ts
export const CALIBRATION_FITTED = true;
export const CALIBRATION_FEATURES = ${JSON.stringify(design.featureNames)} as const;
export const CALIBRATION_COEFFICIENTS = ${JSON.stringify(beta.map((b) => Number(b.toFixed(8))))} as const;
\`\`\`

${snapshot}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`could not connect: ${redact(err)}`);
  }

  try {
    // Hard read-only guarantee — the server, not the author, enforces it.
    await client.query('set session characteristics as transaction read only');

    const data = await load(client);
    const design = buildDesign(data.rows);

    // Re-measure the quantiles live so the report quantifies its own drift
    // rather than asserting a number that goes stale the moment it is written.
    const snapshot = quantileSnapshotSection(
      await loadLiveQuantiles(client),
      new Date().toISOString()
    );

    const positives = design.y.reduce((a, b) => a + b, 0);
    const featureCount = Math.max(1, design.featureNames.length - 1);
    const required = Math.max(MIN_POSITIVES_ABSOLUTE, MIN_EVENTS_PER_FEATURE * featureCount);

    console.log(`[fit-platt] rows total          : ${data.totalRows}`);
    console.log(`[fit-platt] rows usable         : ${design.y.length}`);
    console.log(`[fit-platt] positives (cited)   : ${positives}`);
    console.log(`[fit-platt] dismissed (table)   : ${data.dismissedAll}`);
    console.log(`[fit-platt] features surviving  : ${design.featureNames.join(', ')}`);
    console.log(`[fit-platt] positives required  : ${required}`);

    mkdirSync(dirname(REPORT_PATH), { recursive: true });

    if (positives < required || design.y.length - positives < required) {
      writeFileSync(REPORT_PATH, insufficientLabelsReport(data, design, required, snapshot), 'utf8');
      console.log(`[fit-platt] VERDICT: INSUFFICIENT LABELS — no coefficients emitted.`);
      console.log(`[fit-platt] report written to ${REPORT_PATH}`);
      return;
    }

    // Deterministic split.
    const trainIdx: number[] = [];
    const testIdx: number[] = [];
    for (let i = 0; i < design.ids.length; i++) {
      (hashUnit(design.ids[i] ?? String(i)) < TRAIN_FRACTION ? trainIdx : testIdx).push(i);
    }

    const fit = fitLogistic(
      trainIdx.map((i) => design.X[i] ?? []),
      trainIdx.map((i) => design.y[i] ?? 0)
    );
    if (!fit) throw new Error('IRLS failed to solve (singular Hessian) — inspect the design matrix.');

    const testX = testIdx.map((i) => design.X[i] ?? []);
    const testY = testIdx.map((i) => design.y[i] ?? 0);
    const scoreCol = design.featureNames.indexOf('score');
    const preds = testX.map((row) => {
      let z = 0;
      for (let j = 0; j < row.length; j++) z += (row[j] ?? 0) * (fit.beta[j] ?? 0);
      return sigmoid(z);
    });
    const baseline = testX.map((row) => (scoreCol >= 0 ? (row[scoreCol] ?? 0) : 0));

    writeFileSync(
      REPORT_PATH,
      fittedReport(data, design, fit.beta, fit.iterations, {
        trainN: trainIdx.length,
        testN: testIdx.length,
        testPos: testY.reduce((a, b) => a + b, 0),
        aucModel: auc(preds, testY),
        aucBaseline: auc(baseline, testY),
        brierModel: brier(preds, testY),
        brierBase: brier(baseline, testY),
        logLossModel: logLoss(preds, testY),
      }, snapshot),
      'utf8'
    );
    console.log(`[fit-platt] VERDICT: FITTED — report written to ${REPORT_PATH}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(`[fit-platt] ${redact(err)}`);
  process.exitCode = 1;
});

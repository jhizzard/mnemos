/**
 * Mnestra — `mnestra doctor` unit tests (Sprint 51.5 T2)
 *
 * Drives runDoctor() with an injected fake DataSource + fake fs so the
 * tests never touch a real Supabase or the user's home directory.
 *
 * Acceptance criteria covered (per docs/sprint-51.5-installer-upgrade-and-doctor/T2-mnestra-doctor.md § Acceptance):
 *   1. all-green path                                  → "all-green path"
 *   2. all-zeros detection (≥6 of 10 zero runs)         → "all-zeros red fires once 6/10 runs are zero"
 *   3. schema-drift detection                          → "schema drift red lists missing artifacts"
 *   4. MCP path parity (3 fixtures)                    → "MCP path parity green / red / yellow"
 *   5. latency probe yellow                            → "latency probe yellow when p95 ≥ 5s"
 *   6. cold-boot tolerance (≤5 runs no-fire)            → "cold-boot tolerance: <6 successful runs never fires red"
 *
 * Plus one extra: cron return_message parser handles JSON + key=value.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runDoctor,
  parseCronReturnMessage,
  type CronRunRecord,
  type DoctorDataSource,
  type FsLike,
  type McpPaths,
  type RumenJobRecord,
} from '../src/doctor.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

/** Build a synthetic rumen-tick / graph-inference cron run. */
function makeRun(opts: {
  jobname: string;
  status?: string;
  startMinAgo?: number;
  durationSec?: number;
  returnMessage?: string | null;
}): CronRunRecord {
  const startMinAgo = opts.startMinAgo ?? 5;
  const start = new Date(Date.now() - startMinAgo * 60_000);
  const end = new Date(start.getTime() + (opts.durationSec ?? 1) * 1000);
  return {
    jobname: opts.jobname,
    status: opts.status ?? 'succeeded',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    return_message: opts.returnMessage ?? null,
  };
}

/**
 * Sequence-aware fake DataSource. Each probe method either returns a
 * fixed value, draws from a per-job array, or throws to simulate the
 * "doctor RPC not installed" path.
 */
interface FakeOpts {
  cronRuns?: Partial<Record<'rumen-tick' | 'graph-inference-tick', CronRunRecord[]>>;
  cronRunsThrow?: boolean;
  cronJobExists?: Record<string, boolean>;
  columnExists?: Record<string, boolean>; // key: `${table}.${column}`
  rpcExists?: Record<string, boolean>;
  vaultSecretExists?: Record<string, boolean>;
  schemaProbeThrow?: boolean;
  rumenJobs?: RumenJobRecord[];
  rumenJobsThrow?: boolean;
}

function makeFakeData(opts: FakeOpts): DoctorDataSource {
  return {
    async cronJobRunDetails(jobname, _limit) {
      if (opts.cronRunsThrow) throw new Error('mnestra_doctor_cron_runs: function does not exist');
      return opts.cronRuns?.[jobname as 'rumen-tick' | 'graph-inference-tick'] ?? [];
    },
    async cronJobExists(jobname) {
      if (opts.schemaProbeThrow) throw new Error('mnestra_doctor_cron_job_exists: function does not exist');
      return opts.cronJobExists?.[jobname] ?? true;
    },
    async columnExists(table, column) {
      if (opts.schemaProbeThrow) throw new Error('mnestra_doctor_column_exists: function does not exist');
      return opts.columnExists?.[`${table}.${column}`] ?? true;
    },
    async rpcExists(name) {
      if (opts.schemaProbeThrow) throw new Error('mnestra_doctor_rpc_exists: function does not exist');
      return opts.rpcExists?.[name] ?? true;
    },
    async vaultSecretExists(name) {
      if (opts.schemaProbeThrow) throw new Error('mnestra_doctor_vault_secret_exists: function does not exist');
      return opts.vaultSecretExists?.[name] ?? true;
    },
    async rumenJobsRecent(_limit) {
      if (opts.rumenJobsThrow) throw new Error('rumen_jobs: relation does not exist');
      return opts.rumenJobs ?? [];
    },
  };
}

const HOME_CANONICAL = '/fake/home/.claude.json';
const HOME_LEGACY = '/fake/home/.claude/mcp.json';
const FAKE_PATHS: McpPaths = {
  canonicalPath: HOME_CANONICAL,
  legacyPath: HOME_LEGACY,
};

function makeFakeFs(files: Record<string, string>): FsLike {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => files[p] ?? '',
  };
}

const MNESTRA_ENTRY = JSON.stringify(
  { mcpServers: { mnestra: { command: 'mnestra' } } },
  null,
  2
);

const NOT_MNESTRA_ENTRY = JSON.stringify({ mcpServers: { other: {} } }, null, 2);

/** Ten healthy rumen-tick runs (sessions_processed > 0). */
function healthyRumenRuns(): CronRunRecord[] {
  return Array.from({ length: 10 }, (_, i) =>
    makeRun({
      jobname: 'rumen-tick',
      startMinAgo: 15 * (i + 1),
      durationSec: 2,
      returnMessage: `{"sessions_processed":${3 + i},"insights_generated":${1 + i}}`,
    })
  );
}

/** Ten healthy graph-inference-tick runs (candidates_scanned > 0). */
function healthyGraphRuns(): CronRunRecord[] {
  return Array.from({ length: 10 }, (_, i) =>
    makeRun({
      jobname: 'graph-inference-tick',
      startMinAgo: 15 * (i + 1),
      durationSec: 2,
      returnMessage: `{"candidates_scanned":${2 + i},"edges_inserted":${1 + i}}`,
    })
  );
}

// ── Tests ────────────────────────────────────────────────────────────────

test('all-green path: healthy crons + canonical-only MCP + present schema → exit 0', async () => {
  const data = makeFakeData({
    cronRuns: { 'rumen-tick': healthyRumenRuns(), 'graph-inference-tick': healthyGraphRuns() },
  });
  const fs = makeFakeFs({ [HOME_CANONICAL]: MNESTRA_ENTRY });

  const report = await runDoctor({ data, fs, mcpPaths: FAKE_PATHS });

  assert.equal(report.exitCode, 0);
  assert.ok(report.results.every((r) => r.status === 'green'), 'all probes should be green');
  // Sanity: probes named in the order we expect.
  const names = report.results.map((r) => r.name);
  assert.deepEqual(names, [
    'rumen-tick all-zeros',
    'rumen-tick latency',
    'graph-inference-tick all-zeros',
    'graph-inference-tick latency',
    'schema drift',
    'MCP config path parity',
    'DATABASE_URL endpoint',
  ]);
});

test('all-zeros red fires once 6/10 runs are zero (Brad scenario)', async () => {
  // 7 zero runs + 3 healthy → exceeds the 6-cycle threshold → red.
  const zeroRuns: CronRunRecord[] = Array.from({ length: 7 }, (_, i) =>
    makeRun({
      jobname: 'rumen-tick',
      startMinAgo: 15 * (i + 1),
      durationSec: 1,
      returnMessage: '{"sessions_processed":0,"insights_generated":0}',
    })
  );
  const healthy: CronRunRecord[] = Array.from({ length: 3 }, (_, i) =>
    makeRun({
      jobname: 'rumen-tick',
      startMinAgo: 15 * (i + 8),
      durationSec: 1,
      returnMessage: '{"sessions_processed":4,"insights_generated":2}',
    })
  );
  const data = makeFakeData({
    cronRuns: { 'rumen-tick': [...zeroRuns, ...healthy], 'graph-inference-tick': healthyGraphRuns() },
  });
  const fs = makeFakeFs({ [HOME_CANONICAL]: MNESTRA_ENTRY });

  const report = await runDoctor({ data, fs, mcpPaths: FAKE_PATHS });

  const allZeros = report.results.find((r) => r.name === 'rumen-tick all-zeros')!;
  assert.equal(allZeros.status, 'red');
  assert.match(allZeros.detail, /7 of last 10 successful runs/);
  assert.ok(
    allZeros.recommendations.some((r) => /INSTALLER-PITFALLS\.md ledger #13/.test(r)),
    'recommendation must cite the canonical doc ledger entry'
  );
  assert.equal(report.exitCode, 1);
});

test('cold-boot tolerance: <6 successful runs never fires red even when all-zero', async () => {
  // Only 5 successful runs all-zero → still green (need ≥6 for red).
  const runs: CronRunRecord[] = Array.from({ length: 5 }, (_, i) =>
    makeRun({
      jobname: 'rumen-tick',
      startMinAgo: 15 * (i + 1),
      durationSec: 1,
      returnMessage: '{"sessions_processed":0,"insights_generated":0}',
    })
  );
  const data = makeFakeData({
    cronRuns: { 'rumen-tick': runs, 'graph-inference-tick': healthyGraphRuns() },
  });
  const fs = makeFakeFs({ [HOME_CANONICAL]: MNESTRA_ENTRY });

  const report = await runDoctor({ data, fs, mcpPaths: FAKE_PATHS });

  const allZeros = report.results.find((r) => r.name === 'rumen-tick all-zeros')!;
  assert.equal(allZeros.status, 'green', 'cold-boot must not flag — Brad soak window is 6+ cycles');
  assert.match(allZeros.detail, /only 5 successful run\(s\) observed/);
});

test('latency probe yellow when p95 ≥ 5s', async () => {
  // 8 fast runs + 2 slow ones → p95 lands on a slow run → yellow.
  const slow = Array.from({ length: 2 }, (_, i) =>
    makeRun({
      jobname: 'rumen-tick',
      startMinAgo: 15 * (i + 1),
      durationSec: 12,
      returnMessage: '{"sessions_processed":3,"insights_generated":1}',
    })
  );
  const fast = Array.from({ length: 8 }, (_, i) =>
    makeRun({
      jobname: 'rumen-tick',
      startMinAgo: 15 * (i + 3),
      durationSec: 1,
      returnMessage: '{"sessions_processed":3,"insights_generated":1}',
    })
  );
  const data = makeFakeData({
    cronRuns: { 'rumen-tick': [...slow, ...fast], 'graph-inference-tick': healthyGraphRuns() },
  });
  const fs = makeFakeFs({ [HOME_CANONICAL]: MNESTRA_ENTRY });

  const report = await runDoctor({ data, fs, mcpPaths: FAKE_PATHS });

  const latency = report.results.find((r) => r.name === 'rumen-tick latency')!;
  assert.equal(latency.status, 'yellow');
  assert.match(latency.detail, /p95 = 12\.0s/);
  assert.equal(report.exitCode, 2, 'yellow but no red → exit 2');
});

test('schema drift red lists missing artifacts with remediation', async () => {
  // weight column missing + memory_recall_graph RPC missing.
  const data = makeFakeData({
    cronRuns: { 'rumen-tick': healthyRumenRuns(), 'graph-inference-tick': healthyGraphRuns() },
    columnExists: { 'memory_relationships.weight': false, 'memory_items.source_agent': true },
    rpcExists: { memory_recall_graph: false },
  });
  const fs = makeFakeFs({ [HOME_CANONICAL]: MNESTRA_ENTRY });

  const report = await runDoctor({ data, fs, mcpPaths: FAKE_PATHS });

  const drift = report.results.find((r) => r.name === 'schema drift')!;
  assert.equal(drift.status, 'red');
  assert.match(drift.detail, /M-009 \(memory_relationships\.weight\)/);
  assert.match(drift.detail, /M-010 \(memory_recall_graph RPC\)/);
  assert.ok(
    drift.recommendations.some((r) => /termdeck init --mnestra/.test(r)),
    'remediation must mention re-running the installer'
  );
  assert.equal(report.exitCode, 1);
});

test('MCP path parity — canonical only → green', async () => {
  const data = makeFakeData({
    cronRuns: { 'rumen-tick': healthyRumenRuns(), 'graph-inference-tick': healthyGraphRuns() },
  });
  const fs = makeFakeFs({ [HOME_CANONICAL]: MNESTRA_ENTRY });

  const report = await runDoctor({ data, fs, mcpPaths: FAKE_PATHS });
  const mcp = report.results.find((r) => r.name === 'MCP config path parity')!;
  assert.equal(mcp.status, 'green');
});

test('MCP path parity — legacy only → red, recommends re-running init --mnestra', async () => {
  const data = makeFakeData({
    cronRuns: { 'rumen-tick': healthyRumenRuns(), 'graph-inference-tick': healthyGraphRuns() },
  });
  const fs = makeFakeFs({ [HOME_LEGACY]: MNESTRA_ENTRY });

  const report = await runDoctor({ data, fs, mcpPaths: FAKE_PATHS });
  const mcp = report.results.find((r) => r.name === 'MCP config path parity')!;
  assert.equal(mcp.status, 'red');
  assert.match(mcp.detail, /deprecated path/);
  assert.ok(mcp.recommendations.some((r) => /termdeck init --mnestra/.test(r)));
});

test('MCP path parity — both paths → yellow, recommends removing legacy', async () => {
  const data = makeFakeData({
    cronRuns: { 'rumen-tick': healthyRumenRuns(), 'graph-inference-tick': healthyGraphRuns() },
  });
  const fs = makeFakeFs({ [HOME_CANONICAL]: MNESTRA_ENTRY, [HOME_LEGACY]: MNESTRA_ENTRY });

  const report = await runDoctor({ data, fs, mcpPaths: FAKE_PATHS });
  const mcp = report.results.find((r) => r.name === 'MCP config path parity')!;
  assert.equal(mcp.status, 'yellow');
  assert.ok(mcp.recommendations.some((r) => /remove the legacy entry/.test(r)));
});

test('cron probe RPC missing → unknown for both jobs, recommends installing migration 016', async () => {
  // Simulates a project that hasn't applied migration 016 yet.
  const data = makeFakeData({ cronRunsThrow: true });
  const fs = makeFakeFs({ [HOME_CANONICAL]: MNESTRA_ENTRY });

  const report = await runDoctor({ data, fs, mcpPaths: FAKE_PATHS });

  const rumenAllZeros = report.results.find((r) => r.name === 'rumen-tick all-zeros')!;
  assert.equal(rumenAllZeros.status, 'unknown');
  assert.ok(rumenAllZeros.recommendations.some((r) => /016_mnestra_doctor_probes\.sql/.test(r)));
  // No red anywhere because the schema/MCP probes still pass — exit 2 (yellow only? actually unknown alone → 0). Let's check: the spec says red→1, yellow→2, else 0. unknown alone → 0.
  // There should be 4 unknowns + 1 schema-drift green + 1 MCP-parity green → exit 0.
  assert.equal(report.exitCode, 0);
});

test('parseCronReturnMessage handles JSON and key=value forms', () => {
  // JSON form
  assert.deepEqual(parseCronReturnMessage('{"sessions_processed":0,"insights_generated":0}'), {
    sessions_processed: 0,
    insights_generated: 0,
  });
  // Bigint-as-string
  assert.deepEqual(parseCronReturnMessage('{"sessions_processed":"7"}'), {
    sessions_processed: 7,
  });
  // key=value form (regex fallback)
  const fields = parseCronReturnMessage(
    '[rumen-tick] cycle done: sessions_processed=0, insights_generated=0, ms_total=42'
  );
  assert.equal(fields.sessions_processed, 0);
  assert.equal(fields.insights_generated, 0);
  assert.equal(fields.ms_total, 42);
  // Empty / null
  assert.deepEqual(parseCronReturnMessage(null), {});
  assert.deepEqual(parseCronReturnMessage(''), {});
});

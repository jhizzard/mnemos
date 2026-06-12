/**
 * Mnestra — `mnestra doctor` (Sprint 51.5 T2)
 *
 * Surfaces the all-zeros pattern that hid an operator schema drift
 * for ~6 days (INSTALLER-PITFALLS.md ledger #13). Four
 * probes; each emits a green / yellow / red / unknown verdict with a
 * one-line recommendation. The CLI shell (mcp-server/index.ts) renders
 * the verdicts and sets the exit code.
 *
 * Probes are pure of I/O; the DataSource is injected so tests never
 * touch a real Supabase.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { evalDbEndpoint } from './db-endpoint.js';

// ── Types ────────────────────────────────────────────────────────────────

export type ProbeStatus = 'green' | 'yellow' | 'red' | 'unknown';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  detail: string;
  recommendations: string[];
}

export interface CronRunRecord {
  jobname: string;
  /** 'succeeded' | 'failed' | 'running' (cron.job_run_details.status) */
  status: string;
  start_time: string;
  end_time: string | null;
  return_message: string | null;
}

/**
 * One row from `public.rumen_jobs` — the rumen package's own per-tick log.
 * Distinct from `cron.job_run_details`: rumen_jobs is a userland queue
 * the rumen-tick Edge Function writes to, with package-level fields like
 * sessions_processed and error_message. cron.job_run_details is pg_cron's
 * scheduler-level wrapper output.
 *
 * Surfacing this row in `mnestra doctor` closes Sprint 51.5b T2 finding #1
 * (cron return_message blindness): when a tick errors, error_message holds
 * the actual reason — doctor surfaces it directly so an auditor's
 * diagnosis-by-doctor matches diagnosis-by-psql.
 */
export interface RumenJobRecord {
  id: string;
  /**
   * NOTE: started_at is set with `DEFAULT NOW()` at INSERT but per Sprint 53
   * T4-CODEX cross-finding (live daily-driver probe at 17:17 ET, 480 rows
   * with completed_at recent but started_at filtered out by 5-day window),
   * may be stale on rows the rumen-tick function UPDATEs without refreshing.
   * Doctor renders BOTH timestamps so any skew is visible.
   */
  started_at: string;
  completed_at: string | null;
  /** 'pending' | 'running' | 'done' | 'failed' (rumen_jobs.status check). */
  status: string;
  sessions_processed: number;
  insights_generated: number;
  /**
   * Populated when status='failed'. The brief originally referred to this
   * as `return_message`, but that field lives on cron.job_run_details, not
   * rumen_jobs — the rumen package writes errors here.
   */
  error_message: string | null;
}

/**
 * The data plane the doctor needs. The default implementation talks to
 * Supabase via the SECURITY DEFINER helpers in migration 016. Tests
 * inject a fake. Each probe must either return a value or throw; the
 * doctor catches and degrades to 'unknown' rather than failing hard.
 */
export interface DoctorDataSource {
  cronJobRunDetails(jobname: string, limit: number): Promise<CronRunRecord[]>;
  cronJobExists(jobname: string): Promise<boolean>;
  columnExists(table: string, column: string): Promise<boolean>;
  rpcExists(name: string): Promise<boolean>;
  vaultSecretExists(name: string): Promise<boolean>;
  /**
   * Newest-first slice of `public.rumen_jobs`. Reads directly (rumen_jobs
   * is in public, not cron/vault — service_role can SELECT without a
   * SECURITY DEFINER wrapper). Throws on connectivity / permission errors;
   * the doctor catches and degrades the rumen-tick informational section
   * to absent rather than failing hard.
   */
  rumenJobsRecent(limit: number): Promise<RumenJobRecord[]>;
}

export interface FsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
}

export interface McpPaths {
  canonicalPath: string;
  legacyPath: string;
}

export interface DoctorOptions {
  data: DoctorDataSource;
  fs?: FsLike;
  mcpPaths?: McpPaths;
  /**
   * Minimum number of consecutive cron cycles before flagging all-zeros
   * as red. Brad's drift hid for ~6 days at 15-min cadence; matching
   * Brad's soak we require at least 6 cycles before flagging.
   */
  minCyclesBeforeFlag?: number;
  /** p95 latency threshold in seconds; >= → yellow. */
  latencyP95ThresholdSeconds?: number;
  /**
   * DATABASE_URL for the endpoint-shape probe (Sprint 74 T2). The CLI
   * passes the resolved value (process env → ~/.termdeck/secrets.env via
   * resolveDatabaseUrl); tests inject a literal or omit. runDoctor never
   * reads process.env itself — ambient resolution stays at the CLI
   * boundary so injected-fixture tests remain hermetic. Undefined →
   * probe reports green/absent.
   */
  databaseUrl?: string;
  /**
   * Override the host's IPv6-capability signal (tests). Undefined → the
   * probe computes it from os.networkInterfaces(), and only when the URL
   * has the IPv6-only direct shape.
   */
  ipv6Capable?: boolean;
}

export interface DoctorReport {
  results: ProbeResult[];
  exitCode: 0 | 1 | 2;
  /**
   * Most-recent rows from `public.rumen_jobs`. Informational (not a probe
   * verdict) — surfacing this in the rendered report lets an auditor see
   * WHEN ticks ran and WHY any failed without dropping to psql. Absent
   * (undefined) when the rumenJobsRecent probe threw or returned empty.
   */
  rumenJobs?: RumenJobRecord[];
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_MIN_CYCLES = 6;
const DEFAULT_LATENCY_P95_SEC = 5;
const CRON_RUN_LIMIT = 10;
const RUMEN_JOBS_RECENT_LIMIT = 5;
/**
 * Truncation budget for raw return_message strings appended to the
 * all-zeros probe detail (Sprint 53 bonus fix). Long error blobs would
 * blow up the rendered output; ~200 chars is enough to identify the
 * Postgres error class without dominating the report.
 */
const RETURN_MESSAGE_TRUNCATE_CHARS = 200;
/** Truncation for rumen_jobs.error_message in the rendered table. */
const ERROR_MESSAGE_TRUNCATE_CHARS = 80;

const CRON_JOBS = ['rumen-tick', 'graph-inference-tick'] as const;

interface ZeroPattern {
  job: (typeof CRON_JOBS)[number];
  /** Field names that, when ALL are zero in a return_message, mark the run as no-op. */
  zeroKeys: string[];
}

const ZERO_PATTERNS: Record<(typeof CRON_JOBS)[number], ZeroPattern> = {
  'rumen-tick': {
    job: 'rumen-tick',
    zeroKeys: ['sessions_processed', 'insights_generated'],
  },
  'graph-inference-tick': {
    job: 'graph-inference-tick',
    zeroKeys: ['candidates_scanned', 'edges_inserted'],
  },
};

interface SchemaTarget {
  kind: 'column' | 'rpc' | 'cronjob' | 'vault';
  /** What the user sees on a missing-artifact line. */
  label: string;
  /** Migration / install action that lands the missing artifact. */
  remediation: string;
  /** Probe args. */
  table?: string;
  column?: string;
  name?: string;
}

const SCHEMA_TARGETS: SchemaTarget[] = [
  {
    kind: 'column',
    table: 'memory_relationships',
    column: 'weight',
    label: 'M-009 (memory_relationships.weight)',
    remediation: 'apply migrations/009_memory_relationship_metadata.sql',
  },
  {
    kind: 'rpc',
    name: 'memory_recall_graph',
    label: 'M-010 (memory_recall_graph RPC)',
    remediation: 'apply migrations/010_memory_recall_graph.sql',
  },
  {
    kind: 'column',
    table: 'memory_items',
    column: 'source_agent',
    label: 'M-015 (memory_items.source_agent)',
    remediation: 'apply migrations/015_source_agent.sql',
  },
  {
    kind: 'cronjob',
    name: 'graph-inference-tick',
    label: 'TD-003 (graph-inference-tick cron)',
    remediation: 're-run `termdeck init --rumen` to apply TermDeck migration 003 (templated)',
  },
  {
    kind: 'vault',
    name: 'graph_inference_service_role_key',
    label: 'graph_inference_service_role_key (vault)',
    remediation: 're-run `termdeck init --rumen` to clone the rumen service role key into vault',
  },
];

// ── Default MCP paths ────────────────────────────────────────────────────

export function defaultMcpPaths(): McpPaths {
  const home = homedir();
  return {
    canonicalPath: join(home, '.claude.json'),
    legacyPath: join(home, '.claude', 'mcp.json'),
  };
}

const defaultFs: FsLike = {
  existsSync: (p) => existsSync(p),
  readFileSync: (p, enc) => readFileSync(p, enc),
};

// ── Probe parsers ────────────────────────────────────────────────────────

/**
 * Try to extract numeric fields from a cron return_message. The
 * Supabase pg_cron convention writes the function's `notice` log lines
 * (or, for HTTP-triggered jobs, the response body) into return_message.
 * For our jobs that's typically a JSON-ish string. Be defensive: parse
 * either real JSON or a `key=value, key=value` blob.
 */
export function parseCronReturnMessage(msg: string | null): Record<string, number> {
  if (!msg) return {};
  // Try strict JSON first.
  try {
    const parsed = JSON.parse(msg);
    if (parsed && typeof parsed === 'object') {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number') out[k] = v;
        else if (typeof v === 'string' && /^-?\d+$/.test(v)) out[k] = Number(v);
      }
      if (Object.keys(out).length > 0) return out;
    }
  } catch {
    // fall through to regex
  }
  // Fall back to `key=N` extraction so we tolerate prefix logs.
  const out: Record<string, number> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:]\s*(-?\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(msg)) !== null) {
    out[m[1]!] = Number(m[2]!);
  }
  return out;
}

// ── Probe evaluators ─────────────────────────────────────────────────────

/**
 * Sprint 53 T3 bonus: collect non-numeric `return_message` strings from runs
 * where `parseCronReturnMessage` extracted zero numeric fields. These are
 * usually Postgres error blobs that the existing detail line silently
 * dropped — surfacing them gives an auditor a one-line root cause without
 * dropping to psql.
 */
function summarizeNonNumericReturnMessages(runs: CronRunRecord[]): string | null {
  const blobs: string[] = [];
  for (const r of runs) {
    if (!r.return_message) continue;
    const parsed = parseCronReturnMessage(r.return_message);
    if (Object.keys(parsed).length > 0) continue;
    const trimmed = r.return_message.trim();
    if (trimmed) blobs.push(trimmed);
  }
  if (blobs.length === 0) return null;
  // Deduplicate so 10 identical errors collapse to one.
  const unique = Array.from(new Set(blobs));
  const sample = unique[0]!;
  const truncated =
    sample.length > RETURN_MESSAGE_TRUNCATE_CHARS
      ? sample.slice(0, RETURN_MESSAGE_TRUNCATE_CHARS) + '…'
      : sample;
  return unique.length === 1
    ? `non-numeric return_message: ${truncated}`
    : `${unique.length} distinct non-numeric return_messages, sample: ${truncated}`;
}

function evalAllZeros(
  job: (typeof CRON_JOBS)[number],
  runs: CronRunRecord[],
  minCycles: number
): ProbeResult {
  const successful = runs.filter((r) => r.status === 'succeeded');
  const nonNumericNote = summarizeNonNumericReturnMessages(runs);
  if (successful.length < minCycles) {
    return {
      name: `${job} all-zeros`,
      status: 'green',
      detail:
        `only ${successful.length} successful run(s) observed (need ≥${minCycles} for confident detection)` +
        (nonNumericNote ? `; ${nonNumericNote}` : ''),
      recommendations: [],
    };
  }
  const pattern = ZERO_PATTERNS[job];
  const zeroRuns = successful.filter((r) => {
    const fields = parseCronReturnMessage(r.return_message);
    if (Object.keys(fields).length === 0) return false; // can't classify
    return pattern.zeroKeys.every((k) => fields[k] === 0);
  });
  // Brad's threshold: ≥6 of 10 successful runs all-zeros → red.
  if (zeroRuns.length >= minCycles) {
    return {
      name: `${job} all-zeros`,
      status: 'red',
      detail:
        `${zeroRuns.length} of last ${successful.length} successful runs reported ${pattern.zeroKeys.join('=0 AND ')}=0` +
        (nonNumericNote ? `; ${nonNumericNote}` : ''),
      recommendations: [
        `likely schema drift — run \`termdeck init --${job === 'rumen-tick' ? 'rumen' : 'rumen'}\` to audit`,
        'reference: docs/INSTALLER-PITFALLS.md ledger #13',
      ],
    };
  }
  return {
    name: `${job} all-zeros`,
    status: 'green',
    detail:
      `${zeroRuns.length} of last ${successful.length} successful runs reported all-zero (below ${minCycles}-cycle threshold)` +
      (nonNumericNote ? `; ${nonNumericNote}` : ''),
    recommendations: [],
  };
}

function evalLatency(
  job: (typeof CRON_JOBS)[number],
  runs: CronRunRecord[],
  thresholdSec: number
): ProbeResult {
  const completed = runs.filter((r) => r.end_time != null && r.status === 'succeeded');
  if (completed.length === 0) {
    return {
      name: `${job} latency`,
      status: 'green',
      detail: 'no completed successful runs to measure',
      recommendations: [],
    };
  }
  const durations = completed
    .map((r) => {
      const start = new Date(r.start_time).getTime();
      const end = new Date(r.end_time as string).getTime();
      return (end - start) / 1000;
    })
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) {
    return {
      name: `${job} latency`,
      status: 'unknown',
      detail: 'could not parse cron run timestamps',
      recommendations: [],
    };
  }
  // p95: index = ceil(0.95 * n) - 1 (clamped).
  const idx = Math.min(durations.length - 1, Math.max(0, Math.ceil(0.95 * durations.length) - 1));
  const p95 = durations[idx]!;
  if (p95 >= thresholdSec) {
    return {
      name: `${job} latency`,
      status: 'yellow',
      detail: `p95 = ${p95.toFixed(1)}s over last ${durations.length} runs (threshold ${thresholdSec}s)`,
      recommendations: [
        `investigate Edge Function logs for slow embedding calls or pg query plans on ${job}`,
      ],
    };
  }
  return {
    name: `${job} latency`,
    status: 'green',
    detail: `p95 = ${p95.toFixed(1)}s over last ${durations.length} runs`,
    recommendations: [],
  };
}

async function evalSchemaDrift(
  data: DoctorDataSource,
  targets: SchemaTarget[]
): Promise<ProbeResult> {
  const missing: SchemaTarget[] = [];
  const unknownProbes: SchemaTarget[] = [];
  for (const t of targets) {
    try {
      let present = false;
      switch (t.kind) {
        case 'column':
          present = await data.columnExists(t.table!, t.column!);
          break;
        case 'rpc':
          present = await data.rpcExists(t.name!);
          break;
        case 'cronjob':
          present = await data.cronJobExists(t.name!);
          break;
        case 'vault':
          present = await data.vaultSecretExists(t.name!);
          break;
      }
      if (!present) missing.push(t);
    } catch {
      unknownProbes.push(t);
    }
  }
  if (missing.length === 0 && unknownProbes.length === 0) {
    return {
      name: 'schema drift',
      status: 'green',
      detail: `all ${targets.length} bundled artifacts present`,
      recommendations: [],
    };
  }
  if (missing.length === 0 && unknownProbes.length > 0) {
    return {
      name: 'schema drift',
      status: 'unknown',
      detail: `could not probe ${unknownProbes.length} of ${targets.length} artifacts (doctor RPC missing?)`,
      recommendations: [
        'apply migrations/016_mnestra_doctor_probes.sql, then re-run',
        'or re-run `termdeck init --mnestra` once T1 audit-upgrade ships in v1.0.1',
      ],
    };
  }
  const lines = missing.map((t) => `    ${t.label} → ${t.remediation}`);
  const recs = [
    `${missing.length} artifact(s) missing — re-run \`termdeck init --mnestra && termdeck init --rumen\``,
    'reference: docs/INSTALLER-PITFALLS.md ledger #13 (Class A — schema drift)',
  ];
  if (unknownProbes.length > 0) {
    recs.push(
      `(${unknownProbes.length} additional probe(s) returned unknown — apply migrations/016_mnestra_doctor_probes.sql for full coverage)`
    );
  }
  return {
    name: 'schema drift',
    status: 'red',
    detail: `${missing.length} artifact(s) missing from bundled set:\n${lines.join('\n')}`,
    recommendations: recs,
  };
}

interface ParsedClaude {
  hasMnestra: boolean;
}

function parseClaudeJson(raw: string): ParsedClaude {
  try {
    const obj = JSON.parse(raw);
    const servers = obj?.mcpServers;
    return { hasMnestra: !!(servers && typeof servers === 'object' && servers.mnestra) };
  } catch {
    return { hasMnestra: false };
  }
}

function parseLegacyMcpJson(raw: string): ParsedClaude {
  try {
    const obj = JSON.parse(raw);
    // Legacy shape was usually `{ mcpServers: { mnestra: ... } }` too.
    const servers = obj?.mcpServers ?? obj;
    return { hasMnestra: !!(servers && typeof servers === 'object' && servers.mnestra) };
  } catch {
    return { hasMnestra: false };
  }
}

function evalMcpPathParity(fs: FsLike, paths: McpPaths): ProbeResult {
  const canonicalExists = fs.existsSync(paths.canonicalPath);
  const legacyExists = fs.existsSync(paths.legacyPath);
  const canonical: ParsedClaude = canonicalExists
    ? parseClaudeJson(fs.readFileSync(paths.canonicalPath, 'utf8'))
    : { hasMnestra: false };
  const legacy: ParsedClaude = legacyExists
    ? parseLegacyMcpJson(fs.readFileSync(paths.legacyPath, 'utf8'))
    : { hasMnestra: false };

  if (canonical.hasMnestra && !legacy.hasMnestra) {
    return {
      name: 'MCP config path parity',
      status: 'green',
      detail: `mnestra registered in ${paths.canonicalPath} only (canonical)`,
      recommendations: [],
    };
  }
  if (canonical.hasMnestra && legacy.hasMnestra) {
    return {
      name: 'MCP config path parity',
      status: 'yellow',
      detail: `mnestra registered in BOTH ${paths.canonicalPath} and ${paths.legacyPath}`,
      recommendations: [
        `remove the legacy entry from ${paths.legacyPath} (Sprint 36 v0.8.0 deprecated it)`,
      ],
    };
  }
  if (!canonical.hasMnestra && legacy.hasMnestra) {
    return {
      name: 'MCP config path parity',
      status: 'red',
      detail: `mnestra registered in ${paths.legacyPath} only (deprecated path)`,
      recommendations: [
        're-run `termdeck init --mnestra` to migrate the entry into ~/.claude.json',
        'reference: docs/INSTALLER-PITFALLS.md ledger #9 (Class B — path mismatch)',
      ],
    };
  }
  return {
    name: 'MCP config path parity',
    status: 'red',
    detail: 'mnestra MCP not registered in either ~/.claude.json or ~/.claude/mcp.json',
    recommendations: ['run `termdeck init --mnestra` to register the MCP server'],
  };
}

// ── Public entrypoint ────────────────────────────────────────────────────

function computeExitCode(results: ProbeResult[]): 0 | 1 | 2 {
  if (results.some((r) => r.status === 'red')) return 1;
  if (results.some((r) => r.status === 'yellow')) return 2;
  return 0;
}

async function safeCronProbe(
  data: DoctorDataSource,
  job: string
): Promise<{ ok: true; runs: CronRunRecord[] } | { ok: false; error: string }> {
  try {
    const runs = await data.cronJobRunDetails(job, CRON_RUN_LIMIT);
    return { ok: true, runs };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const minCycles = opts.minCyclesBeforeFlag ?? DEFAULT_MIN_CYCLES;
  const latencyThreshold = opts.latencyP95ThresholdSeconds ?? DEFAULT_LATENCY_P95_SEC;
  const fs = opts.fs ?? defaultFs;
  const mcpPaths = opts.mcpPaths ?? defaultMcpPaths();

  const results: ProbeResult[] = [];

  // Probes 1+2 — cron all-zeros + per-tick latency for each job.
  for (const job of CRON_JOBS) {
    const probe = await safeCronProbe(opts.data, job);
    if (!probe.ok) {
      results.push({
        name: `${job} all-zeros`,
        status: 'unknown',
        detail: `cron probe failed: ${probe.error}`,
        recommendations: [
          'apply migrations/016_mnestra_doctor_probes.sql to install the SECURITY DEFINER probe wrappers',
        ],
      });
      results.push({
        name: `${job} latency`,
        status: 'unknown',
        detail: `cron probe failed: ${probe.error}`,
        recommendations: [],
      });
      continue;
    }
    results.push(evalAllZeros(job, probe.runs, minCycles));
    results.push(evalLatency(job, probe.runs, latencyThreshold));
  }

  // Probe 3 — schema drift.
  results.push(await evalSchemaDrift(opts.data, SCHEMA_TARGETS));

  // Probe 4 — MCP config path parity.
  results.push(evalMcpPathParity(fs, mcpPaths));

  // Probe 5 — DATABASE_URL endpoint IPv4 safety (Sprint 74 T2, Brad R730
  // field report): db.<project-ref>.supabase.co is AAAA-only, so a pasted
  // direct/Dedicated-Pooler URL hangs until pool timeout on IPv4-only
  // hosts. Shape-only check — no connection is opened.
  results.push(evalDbEndpoint(opts.databaseUrl, opts.ipv6Capable));

  // Informational section — most-recent rumen_jobs rows. Not a probe verdict
  // (no green/red), just visibility into the rumen-tick log so an auditor
  // sees error_message + sessions/insights counts inline.
  //
  // Sprint 53 T3 17:18 ET: switched ordering from started_at DESC to
  // `coalesce(completed_at, started_at) DESC NULLS LAST` after the live
  // daily-driver probe confirmed T4-CODEX's 17:17 ET cross-finding —
  // started_at is NULL on legacy rows because the migration's
  // NOT NULL DEFAULT was wrapped in ADD COLUMN IF NOT EXISTS and skipped.
  // The DataSource handles ordering; the renderer surfaces both
  // timestamps so a NULL started_at remains visible to the auditor.
  let rumenJobs: RumenJobRecord[] | undefined;
  try {
    rumenJobs = await opts.data.rumenJobsRecent(RUMEN_JOBS_RECENT_LIMIT);
  } catch {
    rumenJobs = undefined;
  }

  return { results, exitCode: computeExitCode(results), rumenJobs };
}

// ── Renderer ─────────────────────────────────────────────────────────────

const ICONS: Record<ProbeStatus, string> = {
  green: '✓',
  yellow: '!',
  red: '✗',
  unknown: '?',
};

function truncate(s: string | null, max: number): string {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + '…';
}

/**
 * Sprint 53 T3: render the "Recent rumen ticks" informational section
 * after the probe verdicts. Surfaces error_message inline so an auditor's
 * diagnosis-by-doctor matches diagnosis-by-psql. Keeps both started_at and
 * completed_at columns so any clock skew (T4-CODEX 17:17 ET cross-finding)
 * remains visible.
 */
export function formatRumenJobs(rows: RumenJobRecord[]): string[] {
  const out: string[] = [];
  out.push('');
  out.push('Recent rumen ticks');
  if (rows.length === 0) {
    out.push('  (no rumen_jobs rows returned)');
    return out;
  }
  const header =
    '  started_at                 completed_at               status     sessions  insights  error_message';
  const sep =
    '  -------------------------  -------------------------  ---------  --------  --------  -------------';
  out.push(header);
  out.push(sep);
  for (const r of rows) {
    const started = r.started_at ? r.started_at.slice(0, 25).padEnd(25) : '—'.padEnd(25);
    const completed = (r.completed_at ?? '—').slice(0, 25).padEnd(25);
    const status = (r.status ?? '?').padEnd(9);
    const sessions = String(r.sessions_processed).padStart(8);
    const insights = String(r.insights_generated).padStart(8);
    const errMsg = truncate(r.error_message, ERROR_MESSAGE_TRUNCATE_CHARS);
    out.push(`  ${started}  ${completed}  ${status}  ${sessions}  ${insights}  ${errMsg}`);
  }
  return out;
}

export function formatDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    lines.push(`${ICONS[r.status]} ${r.name} — ${r.detail}`);
    for (const rec of r.recommendations) lines.push(`  → ${rec}`);
  }
  const tally = {
    red: report.results.filter((r) => r.status === 'red').length,
    yellow: report.results.filter((r) => r.status === 'yellow').length,
    green: report.results.filter((r) => r.status === 'green').length,
    unknown: report.results.filter((r) => r.status === 'unknown').length,
  };
  if (report.rumenJobs !== undefined) {
    for (const line of formatRumenJobs(report.rumenJobs)) lines.push(line);
  }
  lines.push('');
  lines.push(
    `Doctor complete. ${tally.red} red, ${tally.yellow} yellow, ${tally.green} green, ${tally.unknown} unknown. Exit ${report.exitCode}.`
  );
  return lines.join('\n');
}

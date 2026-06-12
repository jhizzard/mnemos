/**
 * Mnestra — DATABASE_URL endpoint-shape probe tests (Sprint 74 T2).
 *
 * Pure URL-shape units — no live DB, no ambient env, no real network
 * interfaces. Covers the Brad R730 field report: the direct endpoint
 * `db.<project-ref>.supabase.co` (and the Dedicated Pooler on the same
 * host) is IPv6-only; IPv4-only hosts need the Shared Pooler
 * `aws-<n>-<region>.pooler.supabase.com` with user `postgres.<project-ref>`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDbEndpoint,
  evalDbEndpoint,
  hasGlobalIpv6,
  resolveDatabaseUrl,
  type NetAddressInfo,
} from '../src/db-endpoint.js';
import {
  runDoctor,
  type CronRunRecord,
  type DoctorDataSource,
  type FsLike,
  type McpPaths,
} from '../src/doctor.js';

// All fixtures use placeholder refs only — never a real project ref.
const REF = 'abcdefghijklmnopqrst';
const PW = 'p4ssw0rd';

const DIRECT_5432 = `postgres://postgres:${PW}@db.${REF}.supabase.co:5432/postgres`;
const DEDICATED_6543 = `postgres://postgres:${PW}@db.${REF}.supabase.co:6543/postgres`;
const SHARED_TX_AWS0 = `postgres://postgres.${REF}:${PW}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const SHARED_TX_AWS1 = `postgres://postgres.${REF}:${PW}@aws-1-us-east-2.pooler.supabase.com:6543/postgres`;
const SHARED_SESSION = `postgres://postgres.${REF}:${PW}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`;
const SHARED_BAD_USER = `postgres://postgres:${PW}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

// ── classifyDbEndpoint ───────────────────────────────────────────────────

test('classify: direct endpoint at :5432 → direct', () => {
  const c = classifyDbEndpoint(DIRECT_5432);
  assert.equal(c.kind, 'direct');
  assert.equal(c.host, `db.${REF}.supabase.co`);
  assert.equal(c.port, '5432');
});

test('classify: Dedicated Pooler (:6543 on the db.* host) → direct (same IPv6-only DNS)', () => {
  const c = classifyDbEndpoint(DEDICATED_6543);
  assert.equal(c.kind, 'direct');
  assert.equal(c.port, '6543');
});

test('classify: direct endpoint with no explicit port → direct (libpq defaults 5432)', () => {
  assert.equal(classifyDbEndpoint(`postgresql://postgres:${PW}@db.${REF}.supabase.co/postgres`).kind, 'direct');
});

test('classify: .supabase.in direct host and trailing-dot FQDN → direct', () => {
  assert.equal(classifyDbEndpoint(`postgres://postgres:${PW}@db.${REF}.supabase.in:5432/postgres`).kind, 'direct');
  assert.equal(classifyDbEndpoint(`postgres://postgres:${PW}@db.${REF}.supabase.co.:5432/postgres`).kind, 'direct');
});

test('classify: Shared Pooler transaction mode, aws-0 and aws-1 regional prefixes → shared-pooler', () => {
  for (const url of [SHARED_TX_AWS0, SHARED_TX_AWS1]) {
    const c = classifyDbEndpoint(url);
    assert.equal(c.kind, 'shared-pooler');
    assert.equal(c.poolerUserMismatch, false);
  }
});

test('classify: Shared Pooler session mode (:5432) is still pooler-safe', () => {
  assert.equal(classifyDbEndpoint(SHARED_SESSION).kind, 'shared-pooler');
});

test('classify: pooler host with bare `postgres` user → poolerUserMismatch ("Tenant or user not found")', () => {
  const c = classifyDbEndpoint(SHARED_BAD_USER);
  assert.equal(c.kind, 'shared-pooler');
  assert.equal(c.poolerUserMismatch, true);
});

test('classify: localhost / 127.0.0.1 / [::1] → local', () => {
  assert.equal(classifyDbEndpoint('postgres://postgres:x@localhost:5432/db').kind, 'local');
  assert.equal(classifyDbEndpoint('postgres://postgres:x@127.0.0.1:5432/db').kind, 'local');
  assert.equal(classifyDbEndpoint('postgres://postgres:x@[::1]:5432/db').kind, 'local');
});

test('classify: self-hosted / non-Supabase host → other', () => {
  assert.equal(classifyDbEndpoint('postgres://app:x@pg.internal.example.com:5432/db').kind, 'other');
});

test('classify: absent and whitespace-only → absent', () => {
  assert.equal(classifyDbEndpoint(undefined).kind, 'absent');
  assert.equal(classifyDbEndpoint(null).kind, 'absent');
  assert.equal(classifyDbEndpoint('').kind, 'absent');
  assert.equal(classifyDbEndpoint('   ').kind, 'absent');
});

test('classify: garbage and non-postgres protocols → invalid', () => {
  assert.equal(classifyDbEndpoint('not a url').kind, 'invalid');
  // The HTTPS project URL (SUPABASE_URL) is NOT a connection string.
  assert.equal(classifyDbEndpoint(`https://${REF}.supabase.co`).kind, 'invalid');
});

test('classify: surrounding quotes are stripped before parsing (Brad #2 quoted-env defense)', () => {
  assert.equal(classifyDbEndpoint(`"${DIRECT_5432}"`).kind, 'direct');
  assert.equal(classifyDbEndpoint(`'${SHARED_TX_AWS0}'`).kind, 'shared-pooler');
});

// ── hasGlobalIpv6 ────────────────────────────────────────────────────────

function iface(address: string, opts?: Partial<NetAddressInfo>): NetAddressInfo {
  return { family: 'IPv6', internal: false, address, ...opts };
}

test('hasGlobalIpv6: loopback-only / link-local / unique-local do NOT count', () => {
  assert.equal(hasGlobalIpv6({ lo0: [iface('::1', { internal: true })] }), false);
  assert.equal(hasGlobalIpv6({ en0: [iface('fe80::1c2d:3e4f:5a6b:7c8d')] }), false);
  assert.equal(hasGlobalIpv6({ en0: [iface('fd00::1234')] }), false);
  assert.equal(hasGlobalIpv6({}), false);
});

test('hasGlobalIpv6: global-unicast (2000::/3) on a non-internal interface counts', () => {
  assert.equal(hasGlobalIpv6({ en0: [iface('2600:1700:abcd::1')] }), true);
  // Node has historically flip-flopped string/numeric family — accept both.
  assert.equal(hasGlobalIpv6({ en0: [iface('2001:db8::2', { family: 6 })] }), true);
  assert.equal(hasGlobalIpv6({ en0: [iface('3fff:db8::1')] }), true);
});

test('hasGlobalIpv6: internal or IPv4 entries are ignored; undefined iface arrays tolerated', () => {
  assert.equal(hasGlobalIpv6({ en0: [iface('2600::1', { internal: true })] }), false);
  assert.equal(
    hasGlobalIpv6({ en0: [{ family: 'IPv4', internal: false, address: '192.168.1.2' }], bad: undefined }),
    false
  );
});

// ── evalDbEndpoint probe verdicts ────────────────────────────────────────

test('probe: absent → green, names the HTTPS architecture', () => {
  const r = evalDbEndpoint(undefined);
  assert.equal(r.status, 'green');
  assert.match(r.detail, /HTTPS/);
  assert.match(r.detail, /SUPABASE_URL/);
});

test('probe: direct + NO IPv6 → red, names pool timeout and the Shared Pooler fix', () => {
  const r = evalDbEndpoint(DIRECT_5432, false);
  assert.equal(r.status, 'red');
  assert.match(r.detail, /IPv6-only/);
  assert.match(r.detail, /pool\/connect timeout/);
  const recs = r.recommendations.join('\n');
  assert.match(recs, /Use IPv4 connection \(Shared Pooler\)/);
  assert.match(recs, /aws-<n>-<region>\.pooler\.supabase\.com/);
  assert.match(recs, /postgres\.<project-ref>/);
});

test('probe: Dedicated Pooler (:6543 on db.* host) + NO IPv6 → red, calls out the Dedicated Pooler', () => {
  const r = evalDbEndpoint(DEDICATED_6543, false);
  assert.equal(r.status, 'red');
  assert.match(r.detail, /Dedicated Pooler/);
});

test('probe: direct + IPv6 present → yellow (works here, breaks on IPv4-only hosts)', () => {
  const r = evalDbEndpoint(DIRECT_5432, true);
  assert.equal(r.status, 'yellow');
  assert.match(r.detail, /IPv4-only host/);
  assert.ok(r.recommendations.length > 0, 'still recommends the pooler');
});

test('probe: shared pooler → green; pooler user mismatch → yellow naming "Tenant or user not found"', () => {
  assert.equal(evalDbEndpoint(SHARED_TX_AWS1, false).status, 'green');
  const bad = evalDbEndpoint(SHARED_BAD_USER, false);
  assert.equal(bad.status, 'yellow');
  assert.match(bad.detail, /Tenant or user not found/);
});

test('probe: local and non-Supabase hosts → green; unparseable → yellow', () => {
  assert.equal(evalDbEndpoint('postgres://postgres:x@localhost:5432/db', false).status, 'green');
  assert.equal(evalDbEndpoint('postgres://app:x@pg.internal.example.com:5432/db', false).status, 'green');
  assert.equal(evalDbEndpoint('not a url', false).status, 'yellow');
});

// ── resolveDatabaseUrl (CLI-boundary ambient resolution) ─────────────────

const SECRETS_PATH = '/fake/home/.termdeck/secrets.env';

function fakeFs(files: Record<string, string>): FsLike {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => files[p] ?? '',
  };
}

test('resolve: process env wins when set to a concrete value', () => {
  const url = resolveDatabaseUrl({ DATABASE_URL: DIRECT_5432 }, fakeFs({}), SECRETS_PATH);
  assert.equal(url, DIRECT_5432);
});

test('resolve: unexpanded ${VAR} placeholder in env falls through to secrets.env', () => {
  const fs = fakeFs({
    [SECRETS_PATH]: `# stack secrets\nSUPABASE_URL=https://${REF}.supabase.co\nDATABASE_URL="${SHARED_TX_AWS0}"\n`,
  });
  const url = resolveDatabaseUrl({ DATABASE_URL: '${DATABASE_URL}' }, fs, SECRETS_PATH);
  assert.equal(url, SHARED_TX_AWS0, 'quotes stripped from the secrets.env value');
});

test('resolve: nothing in env, no secrets file → undefined', () => {
  assert.equal(resolveDatabaseUrl({}, fakeFs({}), SECRETS_PATH), undefined);
});

test('resolve: secrets.env without a DATABASE_URL line → undefined; comments ignored', () => {
  const fs = fakeFs({ [SECRETS_PATH]: '# DATABASE_URL=commented-out\nOPENAI_API_KEY=sk-x\n' });
  assert.equal(resolveDatabaseUrl({}, fs, SECRETS_PATH), undefined);
});

// ── runDoctor wiring ─────────────────────────────────────────────────────

function makeRun(jobname: string, i: number, returnMessage: string): CronRunRecord {
  const start = new Date(Date.now() - 15 * (i + 1) * 60_000);
  return {
    jobname,
    status: 'succeeded',
    start_time: start.toISOString(),
    end_time: new Date(start.getTime() + 2_000).toISOString(),
    return_message: returnMessage,
  };
}

function allGreenData(): DoctorDataSource {
  return {
    async cronJobRunDetails(jobname) {
      const msg =
        jobname === 'rumen-tick'
          ? '{"sessions_processed":3,"insights_generated":1}'
          : '{"candidates_scanned":2,"edges_inserted":1}';
      return Array.from({ length: 10 }, (_, i) => makeRun(jobname, i, msg));
    },
    async cronJobExists() {
      return true;
    },
    async columnExists() {
      return true;
    },
    async rpcExists() {
      return true;
    },
    async vaultSecretExists() {
      return true;
    },
    async rumenJobsRecent() {
      return [];
    },
  };
}

const FAKE_PATHS: McpPaths = {
  canonicalPath: '/fake/home/.claude.json',
  legacyPath: '/fake/home/.claude/mcp.json',
};
const MCP_FS = fakeFs({
  [FAKE_PATHS.canonicalPath]: JSON.stringify({ mcpServers: { mnestra: { command: 'mnestra' } } }),
});

test('runDoctor: no databaseUrl → endpoint probe green/absent, exit 0 (back-compat)', async () => {
  const report = await runDoctor({ data: allGreenData(), fs: MCP_FS, mcpPaths: FAKE_PATHS });
  const probe = report.results.find((r) => r.name === 'DATABASE_URL endpoint');
  assert.ok(probe, 'probe present in report');
  assert.equal(probe!.status, 'green');
  assert.equal(report.exitCode, 0);
});

test('runDoctor: direct URL + ipv6Capable:false → red probe flips exit to 1', async () => {
  const report = await runDoctor({
    data: allGreenData(),
    fs: MCP_FS,
    mcpPaths: FAKE_PATHS,
    databaseUrl: DIRECT_5432,
    ipv6Capable: false,
  });
  const probe = report.results.find((r) => r.name === 'DATABASE_URL endpoint');
  assert.equal(probe!.status, 'red');
  assert.equal(report.exitCode, 1);
});

test('runDoctor: direct URL + ipv6Capable:true → yellow probe flips exit to 2', async () => {
  const report = await runDoctor({
    data: allGreenData(),
    fs: MCP_FS,
    mcpPaths: FAKE_PATHS,
    databaseUrl: DIRECT_5432,
    ipv6Capable: true,
  });
  const probe = report.results.find((r) => r.name === 'DATABASE_URL endpoint');
  assert.equal(probe!.status, 'yellow');
  assert.equal(report.exitCode, 2);
});

test('runDoctor: shared-pooler URL → green probe, exit stays 0', async () => {
  const report = await runDoctor({
    data: allGreenData(),
    fs: MCP_FS,
    mcpPaths: FAKE_PATHS,
    databaseUrl: SHARED_TX_AWS1,
    ipv6Capable: false,
  });
  const probe = report.results.find((r) => r.name === 'DATABASE_URL endpoint');
  assert.equal(probe!.status, 'green');
  assert.equal(report.exitCode, 0);
});
